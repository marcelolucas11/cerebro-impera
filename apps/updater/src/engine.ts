import { join } from 'node:path';
import { UpdaterRefusal, type UpdaterStatus } from '@cerebro/shared/protocol';
import {
  compare,
  MANIFEST,
  MANIFEST_BUNDLE,
  newest,
  parseVersion,
  readManifest,
  signer,
  validCommit,
  versionText,
  type GithubRelease,
  type Manifest,
  type Release,
  type Signer,
} from './release.js';

/*
 * The updater's work, with everything outside it behind small interfaces so
 * the tests can stand in for Docker, GitHub and cosign. Nothing runs through
 * a shell; every command is a fixed list of arguments.
 */

export interface Command {
  /** Runs a program with these arguments; `stdoutTo` / `stdinFrom` are file paths. */
  run(
    args: readonly string[],
    options?: { stdoutTo?: string; stdinFrom?: string },
  ): Promise<{ code: number; output: string }>;
}
export interface Releases {
  list(repository: string): Promise<GithubRelease[]>;
  /** The commit a tag points at, or null if GitHub does not say. */
  commitOf(repository: string, tag: string): Promise<string | null>;
  /** Whether the commit is on the repository's default branch, where changes are reviewed. */
  onDefaultBranch(repository: string, sha: string): Promise<boolean>;
  /** A release file, saved where asked. Small files only. */
  download(url: string, to: string): Promise<void>;
}
export interface Verifier {
  blob(file: string, bundle: string, who: Signer): Promise<boolean>;
  image(reference: string, who: Signer): Promise<boolean>;
}
export interface Disk {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  size(path: string): Promise<number>;
}

export interface Settings {
  /** owner/repo this installation follows. */
  repository: string;
  composeFile: string;
  /** CEREBRO_IMAGE and CEREBRO_VERSION, read by compose. */
  releaseEnv: string;
  backupsDir: string;
  workDir: string;
  healthTimeoutMs: number;
  healthIntervalMs: number;
}

export interface Ports {
  command: Command;
  releases: Releases;
  verifier: Verifier;
  disk: Disk;
  healthy: () => Promise<boolean>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
}

type Job = NonNullable<UpdaterStatus['job']>;

class StepFailed extends Error {
  constructor(readonly problem: string) {
    super(problem);
  }
}

export function readReleaseEnv(content: string): { image: string; version: string } {
  const values = new Map<string, string>();
  for (const line of content.split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match !== null) values.set(match[1] ?? '', match[2] ?? '');
  }
  return { image: values.get('CEREBRO_IMAGE') ?? '', version: values.get('CEREBRO_VERSION') ?? '' };
}

/** The same settings with the image and version swapped; every other line kept as it was. */
export function withRelease(content: string, image: string, version: string): string {
  const wanted = new Map([
    ['CEREBRO_IMAGE', image],
    ['CEREBRO_VERSION', version],
  ]);
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  const out = lines.map((line) => {
    const name = /^([A-Z_]+)=/.exec(line.trim())?.[1];
    if (name === undefined || !wanted.has(name)) return line;
    const value = wanted.get(name) ?? '';
    wanted.delete(name);
    return `${name}=${value}`;
  });
  for (const [name, value] of wanted) out.push(`${name}=${value}`);
  return `${out.join('\n')}\n`;
}

export class Engine {
  private checkedAt: string | null = null;
  private candidate: {
    release: Release;
    manifest: Manifest;
    dir: string;
    who: Signer;
  } | null = null;
  private job: Job | null = null;

  constructor(
    private readonly settings: Settings,
    private readonly ports: Ports,
  ) {}

  private async current(): Promise<string> {
    return readReleaseEnv(await this.ports.disk.read(this.settings.releaseEnv)).version;
  }

  async status(): Promise<UpdaterStatus> {
    const candidate = this.candidate;
    return {
      current: await this.current(),
      checkedAt: this.checkedAt,
      available:
        candidate === null
          ? null
          : {
              version: candidate.manifest.version,
              publishedAt: candidate.release.publishedAt,
              notes: candidate.release.notes,
            },
      job: this.job === null ? null : { ...this.job },
    };
  }

  /** Looks for a newer release and holds it only if its signed manifest checks out. */
  async check(): Promise<UpdaterStatus> {
    if (this.job?.state === 'running') throw new UpdaterRefusal('busy');
    const current = parseVersion(await this.current());
    this.candidate = null;
    this.checkedAt = this.ports.now().toISOString();
    if (current === null) throw new UpdaterRefusal('current_unknown');
    const release = newest(await this.ports.releases.list(this.settings.repository), current);
    if (release === null) return this.status();

    const manifestAsset = release.assets.find((asset) => asset.name === MANIFEST);
    const bundleAsset = release.assets.find((asset) => asset.name === MANIFEST_BUNDLE);
    if (manifestAsset === undefined || bundleAsset === undefined) {
      throw new UpdaterRefusal('manifest_missing');
    }
    const dir = join(this.settings.workDir, versionText(release.version));
    const file = join(dir, MANIFEST);
    const bundle = join(dir, MANIFEST_BUNDLE);
    // Where the version came from: a commit on the default branch, signed by the flow run there.
    const sha = await this.ports.releases.commitOf(this.settings.repository, release.tag);
    if (!validCommit(sha)) throw new UpdaterRefusal('origin_unknown');
    if (!(await this.ports.releases.onDefaultBranch(this.settings.repository, sha))) {
      throw new UpdaterRefusal('not_reviewed');
    }
    await this.ports.releases.download(manifestAsset.url, file);
    await this.ports.releases.download(bundleAsset.url, bundle);
    const who = signer(this.settings.repository, release.tag, sha);
    if (!(await this.ports.verifier.blob(file, bundle, who))) {
      throw new UpdaterRefusal('signature_invalid');
    }
    const manifest = readManifest(
      await this.ports.disk.read(file),
      release,
      this.settings.repository,
    );
    if (manifest === null) throw new UpdaterRefusal('manifest_invalid');
    const oldest = parseVersion(manifest.minFrom);
    if (oldest !== null && compare(current, oldest) < 0) throw new UpdaterRefusal('too_old');
    this.candidate = { release, manifest, dir, who };
    return this.status();
  }

  /** Starts the update to the version just found; the work goes on after this answers. */
  async apply(version: string): Promise<UpdaterStatus> {
    if (this.job?.state === 'running') throw new UpdaterRefusal('busy');
    const candidate = this.candidate;
    if (candidate === null || candidate.manifest.version !== version) {
      throw new UpdaterRefusal('not_available');
    }
    const from = await this.current();
    this.job = {
      id: this.ports.newId(),
      from,
      to: version,
      state: 'running',
      step: 'verify',
      startedAt: this.ports.now().toISOString(),
      finishedAt: null,
      problem: null,
    };
    void this.run(this.job, candidate);
    return this.status();
  }

  /** Waits for the update in progress to end (for tests and for shutting down cleanly). */
  async settle(): Promise<void> {
    while (this.job?.state === 'running') await this.ports.sleep(5);
  }

  private compose(...args: string[]): string[] {
    return [
      'docker',
      'compose',
      '--file',
      this.settings.composeFile,
      '--env-file',
      this.settings.releaseEnv,
      ...args,
    ];
  }

  private async must(
    args: readonly string[],
    problem: string,
    options?: { stdoutTo?: string; stdinFrom?: string },
  ): Promise<void> {
    const result = await this.ports.command.run(args, options);
    if (result.code !== 0) throw new StepFailed(problem);
  }

  private async waitHealthy(): Promise<boolean> {
    const deadline = this.ports.now().getTime() + this.settings.healthTimeoutMs;
    while (this.ports.now().getTime() < deadline) {
      if (await this.ports.healthy().catch(() => false)) return true;
      await this.ports.sleep(this.settings.healthIntervalMs);
    }
    return false;
  }

  private finish(job: Job, state: Job['state'], problem: string | null): void {
    job.state = state;
    job.problem = problem;
    job.finishedAt = this.ports.now().toISOString();
  }

  private async run(
    job: Job,
    candidate: { release: Release; manifest: Manifest; dir: string; who: Signer },
  ): Promise<void> {
    const { manifest, dir, who } = candidate;
    const reference = `${manifest.image}@${manifest.digest}`;
    const previousEnv = await this.ports.disk.read(this.settings.releaseEnv);
    const stamp = job.startedAt.replace(/[^0-9]/g, '').slice(0, 14);
    const backup = join(this.settings.backupsDir, `antes-de-${job.to}-${stamp}.dump`);

    // Nothing changes until the backup is safe: a failure here only stops.
    try {
      job.step = 'verify';
      const blobHolds = await this.ports.verifier.blob(
        join(dir, MANIFEST),
        join(dir, MANIFEST_BUNDLE),
        who,
      );
      if (!blobHolds || !(await this.ports.verifier.image(reference, who))) {
        throw new StepFailed('A assinatura da versão não conferiu. Nada foi trocado.');
      }
      job.step = 'backup';
      await this.must(
        this.compose(
          'exec',
          '-T',
          'postgres',
          'pg_dump',
          '--username',
          'postgres',
          '--format',
          'custom',
          'cerebro',
        ),
        'Não foi possível copiar o banco de dados. Nada foi trocado.',
        { stdoutTo: backup },
      );
      if ((await this.ports.disk.size(backup)) === 0) {
        throw new StepFailed('A cópia do banco de dados saiu vazia. Nada foi trocado.');
      }
    } catch (error) {
      this.finish(
        job,
        'failed',
        error instanceof StepFailed ? error.problem : 'Falha inesperada. Nada foi trocado.',
      );
      return;
    }

    // From here on, any failure brings the previous version back, with the database as it was.
    try {
      job.step = 'download';
      await this.must(['docker', 'pull', reference], 'Não foi possível baixar a versão nova.');
      await this.ports.disk.write(
        this.settings.releaseEnv,
        withRelease(previousEnv, reference, manifest.version),
      );
      job.step = 'migrate';
      await this.must(
        this.compose('run', '--rm', 'migrate'),
        'O banco de dados não pôde ser atualizado.',
      );
      job.step = 'start';
      await this.must(
        this.compose('up', '--detach', '--no-deps', 'api'),
        'A versão nova não subiu.',
      );
      job.step = 'health';
      if (!(await this.waitHealthy())) {
        throw new StepFailed('A versão nova não respondeu bem a tempo.');
      }
      this.candidate = null;
      this.finish(job, 'applied', null);
    } catch (error) {
      const problem = error instanceof StepFailed ? error.problem : 'Falha inesperada.';
      job.step = 'rollback';
      try {
        await this.ports.disk.write(this.settings.releaseEnv, previousEnv);
        await this.must(this.compose('stop', 'api'), 'parar');
        await this.must(
          this.compose(
            'exec',
            '-T',
            'postgres',
            'pg_restore',
            '--username',
            'postgres',
            '--dbname',
            'cerebro',
            '--clean',
            '--if-exists',
            '--single-transaction',
          ),
          'restaurar',
          { stdinFrom: backup },
        );
        await this.must(this.compose('up', '--detach', '--no-deps', 'api'), 'subir');
        if (!(await this.waitHealthy())) throw new StepFailed('saúde');
        this.finish(job, 'rolled_back', problem);
      } catch {
        this.finish(
          job,
          'failed',
          `${problem} A volta para a versão anterior também falhou: a cópia do banco está em ${backup}.`,
        );
      }
    }
  }
}
