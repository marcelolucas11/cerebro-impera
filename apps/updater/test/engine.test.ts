import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Engine, readReleaseEnv, withRelease, type Ports, type Settings } from '../src/engine.js';
import {
  MANIFEST,
  MANIFEST_BUNDLE,
  newest,
  readManifest,
  signerIdentity,
  type GithubRelease,
} from '../src/release.js';

const REPO = 'exemplo/cerebro';
const DIGEST = `sha256:${createHash('sha256').update('imagem').digest('hex')}`;
const IMAGE = 'ghcr.io/exemplo/cerebro/api';

const release = (tag: string, extra: Partial<GithubRelease> = {}): GithubRelease => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  published_at: '2030-01-01T10:00:00Z',
  body: `Notas da ${tag}`,
  assets: [
    {
      name: MANIFEST,
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${MANIFEST}`,
    },
    {
      name: MANIFEST_BUNDLE,
      browser_download_url: `https://github.com/${REPO}/releases/download/${tag}/${MANIFEST_BUNDLE}`,
    },
  ],
  ...extra,
});

const manifestOf = (version: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ version, image: IMAGE, digest: DIGEST, minFrom: '1.0.0', ...over });

const settings: Settings = {
  repository: REPO,
  composeFile: '/compose/compose.yaml',
  releaseEnv: '/config/release.env',
  backupsDir: '/backups',
  workDir: '/work',
  healthTimeoutMs: 30_000,
  healthIntervalMs: 5_000,
};

/** A whole installation stood in for: files, commands, GitHub, cosign and the API's health. */
function world(options: {
  releases?: GithubRelease[];
  manifest?: string;
  signed?: boolean;
  imageSigned?: boolean;
  failing?: string;
  healthyAfter?: number;
}) {
  const files = new Map<string, string>([
    [
      settings.releaseEnv,
      `CEREBRO_IMAGE=${IMAGE}@sha256:${'0'.repeat(64)}\nCEREBRO_VERSION=1.4.0\n`,
    ],
  ]);
  const commands: string[] = [];
  const verified: string[] = [];
  let clock = Date.UTC(2030, 0, 2, 9, 0, 0);
  let healthChecks = 0;
  const ports: Ports = {
    command: {
      run(args, io = {}) {
        const line = args.join(' ');
        commands.push(line);
        if (io.stdoutTo !== undefined) files.set(io.stdoutTo, 'PGDMP...');
        const fails = options.failing !== undefined && line.includes(options.failing);
        return Promise.resolve({ code: fails ? 1 : 0, output: '' });
      },
    },
    releases: {
      list: () => Promise.resolve(options.releases ?? [release('v1.5.0')]),
      download: (url, to) => {
        files.set(
          to,
          url.endsWith(MANIFEST) ? (options.manifest ?? manifestOf('1.5.0')) : 'bundle',
        );
        return Promise.resolve();
      },
    },
    verifier: {
      blob: (_file, _bundle, identity) => {
        verified.push(`blob ${identity}`);
        return Promise.resolve(options.signed ?? true);
      },
      image: (reference, identity) => {
        verified.push(`image ${reference} ${identity}`);
        return Promise.resolve(options.imageSigned ?? true);
      },
    },
    disk: {
      read: (path) => Promise.resolve(files.get(path) ?? ''),
      write: (path, content) => {
        files.set(path, content);
        return Promise.resolve();
      },
      size: (path) => Promise.resolve((files.get(path) ?? '').length),
    },
    healthy: () => {
      healthChecks += 1;
      return Promise.resolve(healthChecks > (options.healthyAfter ?? 0));
    },
    now: () => new Date(clock),
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    newId: () => 'job-1',
  };
  return { engine: new Engine(settings, ports), files, commands, verified };
}

const compose = (...args: string[]): string =>
  ['docker compose --file /compose/compose.yaml --env-file /config/release.env', ...args].join(' ');

describe('which release is a candidate', () => {
  it('is the highest published, stable one above the version in use', () => {
    const found = newest(
      [
        release('v1.4.0'),
        release('v1.6.0', { draft: true }),
        release('v1.7.0', { prerelease: true }),
        release('1.5.2'),
        release('v1.5.10'),
        release('v2.0.0', { published_at: null }),
        release('nightly'),
      ],
      [1, 4, 0],
    );
    expect(found?.tag).toBe('v1.5.10');
    expect(newest([release('v1.4.0'), release('v1.3.9')], [1, 4, 0])).toBeNull();
  });

  it('must say, signed, the same version, an image of this repository and a digest', () => {
    const candidate = newest([release('v1.5.0')], [1, 4, 0]);
    if (candidate === null) throw new Error('no candidate');
    expect(readManifest(manifestOf('1.5.0'), candidate, REPO)).toMatchObject({ digest: DIGEST });
    for (const bad of [
      manifestOf('1.5.1'),
      manifestOf('1.5.0', { image: 'ghcr.io/outro/cerebro/api' }),
      manifestOf('1.5.0', { image: 'docker.io/exemplo/cerebro/api' }),
      manifestOf('1.5.0', { digest: 'latest' }),
      manifestOf('1.5.0', { minFrom: 'qualquer' }),
      '{"version":"1.5.0"}',
      'não é json',
    ]) {
      expect(readManifest(bad, candidate, REPO), bad).toBeNull();
    }
    expect(signerIdentity(REPO, 'v1.5.0')).toBe(
      'https://github.com/exemplo/cerebro/.github/workflows/release.yml@refs/tags/v1.5.0',
    );
  });
});

describe('looking for an update', () => {
  it('holds a release only when its manifest is signed by this repository release flow', async () => {
    const { engine, verified } = world({});
    const status = await engine.check();
    expect(status.available).toMatchObject({ version: '1.5.0', notes: 'Notas da v1.5.0' });
    expect(verified).toEqual([`blob ${signerIdentity(REPO, 'v1.5.0')}`]);
  });

  it('refuses what is unsigned, off, missing, or too far ahead of this installation', async () => {
    await expect(world({ signed: false }).engine.check()).rejects.toMatchObject({
      code: 'signature_invalid',
    });
    await expect(
      world({ manifest: manifestOf('1.5.0', { image: 'ghcr.io/outro/x/api' }) }).engine.check(),
    ).rejects.toMatchObject({ code: 'manifest_invalid' });
    await expect(
      world({ releases: [release('v1.5.0', { assets: [] })] }).engine.check(),
    ).rejects.toMatchObject({ code: 'manifest_missing' });
    await expect(
      world({ manifest: manifestOf('1.5.0', { minFrom: '1.4.5' }) }).engine.check(),
    ).rejects.toMatchObject({ code: 'too_old' });
    expect((await world({ releases: [] }).engine.check()).available).toBeNull();
  });
});

describe('applying an update', () => {
  it('only to the version just found, one at a time', async () => {
    const { engine } = world({});
    await expect(engine.apply('1.5.0')).rejects.toMatchObject({ code: 'not_available' });
    await engine.check();
    await expect(engine.apply('1.6.0')).rejects.toMatchObject({ code: 'not_available' });
    await engine.apply('1.5.0');
    await expect(engine.apply('1.5.0')).rejects.toMatchObject({ code: 'busy' });
    await expect(engine.check()).rejects.toMatchObject({ code: 'busy' });
    await engine.settle();
  });

  it('verifies, copies the database, then switches the image, migrates and checks health', async () => {
    const { engine, commands, files, verified } = world({ healthyAfter: 2 });
    await engine.check();
    await engine.apply('1.5.0');
    await engine.settle();
    const status = await engine.status();
    expect(status.job).toMatchObject({
      state: 'applied',
      from: '1.4.0',
      to: '1.5.0',
      problem: null,
    });
    expect(status.current).toBe('1.5.0');
    expect(status.available).toBeNull();
    expect(verified.at(-1)).toBe(`image ${IMAGE}@${DIGEST} ${signerIdentity(REPO, 'v1.5.0')}`);
    expect(commands).toEqual([
      compose('exec -T postgres pg_dump --username postgres --format custom cerebro'),
      `docker pull ${IMAGE}@${DIGEST}`,
      compose('run --rm migrate'),
      compose('up --detach --no-deps api'),
    ]);
    expect(readReleaseEnv(files.get(settings.releaseEnv) ?? '')).toEqual({
      image: `${IMAGE}@${DIGEST}`,
      version: '1.5.0',
    });
  });

  it('changes nothing when the image signature does not hold or the copy fails', async () => {
    for (const trouble of [{ imageSigned: false }, { failing: 'pg_dump' }]) {
      const { engine, commands, files } = world(trouble);
      const before = files.get(settings.releaseEnv);
      await engine.check();
      await engine.apply('1.5.0');
      await engine.settle();
      const { job } = await engine.status();
      expect(job?.state).toBe('failed');
      expect(job?.problem).toContain('Nada foi trocado');
      expect(commands.filter((line) => !line.includes('pg_dump'))).toEqual([]);
      expect(files.get(settings.releaseEnv)).toBe(before);
    }
  });

  it('brings the previous version and the database back when the new one fails', async () => {
    const { engine, commands, files } = world({ failing: 'run --rm migrate' });
    const before = files.get(settings.releaseEnv);
    await engine.check();
    await engine.apply('1.5.0');
    await engine.settle();
    const { job, current } = await engine.status();
    expect(job).toMatchObject({
      state: 'rolled_back',
      problem: 'O banco de dados não pôde ser atualizado.',
    });
    expect(current).toBe('1.4.0');
    expect(files.get(settings.releaseEnv)).toBe(before);
    const backup = [...files.keys()].find((path) => path.startsWith('/backups/antes-de-1.5.0-'));
    expect(backup).toBeDefined();
    expect(commands.slice(-3)).toEqual([
      compose('stop api'),
      compose(
        'exec -T postgres pg_restore --username postgres --dbname cerebro --clean --if-exists --single-transaction',
      ),
      compose('up --detach --no-deps api'),
    ]);
  });

  it('rolls back when the new version never answers well, and says so when that fails too', async () => {
    const slow = world({ healthyAfter: 100 });
    await slow.engine.check();
    await slow.engine.apply('1.5.0');
    await slow.engine.settle();
    const { job } = await slow.engine.status();
    expect(job?.state).toBe('failed');
    expect(job?.problem).toContain('A volta para a versão anterior também falhou');
    expect(job?.problem).toContain('/backups/antes-de-1.5.0-');

    const broken = world({ failing: 'docker pull' });
    await broken.engine.check();
    await broken.engine.apply('1.5.0');
    await broken.engine.settle();
    expect((await broken.engine.status()).job).toMatchObject({
      state: 'rolled_back',
      problem: 'Não foi possível baixar a versão nova.',
    });
  });
});

describe('the settings file compose reads', () => {
  it('gets the new image and version, and keeps every other line', () => {
    expect(withRelease('A=1\nCEREBRO_VERSION=1.4.0\nB=2\n', 'img@sha256:x', '1.5.0')).toBe(
      'A=1\nCEREBRO_VERSION=1.5.0\nB=2\nCEREBRO_IMAGE=img@sha256:x\n',
    );
    expect(withRelease('', 'img', '1.0.0')).toBe('CEREBRO_IMAGE=img\nCEREBRO_VERSION=1.0.0\n');
  });
});
