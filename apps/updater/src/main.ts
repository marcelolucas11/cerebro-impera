import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { Engine, type Command, type Ports, type Releases, type Verifier } from './engine.js';
import { validRepository, type GithubRelease } from './release.js';
import { updaterServer } from './server.js';

/*
 * The updater as it runs in its own container: the only one with the Docker
 * socket, reachable only from the API over the internal network. It never
 * updates by itself; it only answers the API.
 */

/** Runs a program without a shell, output kept small; stdin/stdout may be files. */
const command: Command = {
  run: (args, options = {}) =>
    new Promise((resolve) => {
      const [program, ...rest] = args;
      if (program === undefined) {
        resolve({ code: 1, output: '' });
        return;
      }
      const child = spawn(program, rest, {
        stdio: [options.stdinFrom === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,
      });
      const { stdout, stderr } = child;
      if (stdout === null || stderr === null) {
        resolve({ code: 1, output: '' });
        return;
      }
      let output = '';
      const keep = (chunk: Buffer): void => {
        if (output.length < 8192) output += chunk.toString('utf8');
      };
      // When the output goes to a file, the answer waits for the file to be written in full.
      let written: Promise<void> = Promise.resolve();
      if (options.stdoutTo === undefined) {
        stdout.on('data', keep);
      } else {
        const file = createWriteStream(options.stdoutTo, { mode: 0o600 });
        written = new Promise((done) => {
          file.on('close', done);
          file.on('error', () => {
            done();
          });
        });
        stdout.pipe(file);
      }
      stderr.on('data', keep);
      if (options.stdinFrom !== undefined && child.stdin !== null) {
        createReadStream(options.stdinFrom).pipe(child.stdin);
      }
      child.on('error', () => {
        resolve({ code: 1, output });
      });
      child.on('close', (code) => {
        void written.then(() => {
          resolve({ code: code ?? 1, output });
        });
      });
    }),
};

const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const DOWNLOAD_LIMIT = 1024 * 1024;

const releases: Releases = {
  async list(repository) {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=30`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'cerebro-updater',
          'x-github-api-version': '2022-11-28',
        },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`github answered ${String(response.status)}`);
    return (await response.json()) as GithubRelease[];
  },
  async download(url, to) {
    // Release files only, from GitHub, small; redirects are followed only within GitHub.
    let address = new URL(url);
    for (let hop = 0; hop < 5; hop += 1) {
      if (address.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(address.hostname)) {
        throw new Error('download outside GitHub');
      }
      const response = await fetch(address, {
        redirect: 'manual',
        headers: { 'user-agent': 'cerebro-updater' },
        signal: AbortSignal.timeout(20_000),
      });
      const next = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && next !== null) {
        address = new URL(next, address);
        continue;
      }
      if (!response.ok) throw new Error(`download answered ${String(response.status)}`);
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > DOWNLOAD_LIMIT) throw new Error('release file too large');
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await writeFile(to, body, { mode: 0o600 });
      return;
    }
    throw new Error('too many redirects');
  },
};

const verifier: Verifier = {
  blob: async (file, bundle, identity, issuer) =>
    (
      await command.run([
        'cosign',
        'verify-blob',
        '--bundle',
        bundle,
        '--certificate-identity',
        identity,
        '--certificate-oidc-issuer',
        issuer,
        file,
      ])
    ).code === 0,
  image: async (reference, identity, issuer) =>
    (
      await command.run([
        'cosign',
        'verify',
        '--certificate-identity',
        identity,
        '--certificate-oidc-issuer',
        issuer,
        reference,
      ])
    ).code === 0,
};

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const repository = required('CEREBRO_UPDATE_REPOSITORY');
  if (!validRepository(repository)) throw new Error('CEREBRO_UPDATE_REPOSITORY must be owner/repo');
  const configDir = process.env.CEREBRO_CONFIG_DIR ?? '/opt/cerebro/config';
  const key = Buffer.from(
    (await readFile(join(configDir, 'updater-key'), 'utf8')).trim(),
    'base64',
  );
  if (key.length !== 32) throw new Error('the updater key is malformed');
  const healthUrl = process.env.CEREBRO_API_HEALTH_URL ?? 'http://api:3000/api/health';
  const workDir = process.env.CEREBRO_UPDATER_WORK ?? '/var/lib/cerebro-updater';

  const ports: Ports = {
    command,
    releases,
    verifier,
    disk: {
      read: (path) => readFile(path, 'utf8'),
      write: (path, content) => writeFile(path, content, { mode: 0o600 }),
      size: async (path) => (await stat(path)).size,
    },
    healthy: async () => (await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) })).ok,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: randomUUID,
  };
  const engine = new Engine(
    {
      repository,
      composeFile: process.env.CEREBRO_COMPOSE_FILE ?? '/opt/cerebro/compose/compose.yaml',
      releaseEnv: process.env.CEREBRO_RELEASE_ENV ?? '/opt/cerebro/compose/.env',
      backupsDir: process.env.CEREBRO_BACKUPS_DIR ?? '/opt/cerebro/backups',
      workDir,
      healthTimeoutMs: 180_000,
      healthIntervalMs: 5_000,
    },
    ports,
  );
  const port = Number(process.env.CEREBRO_UPDATER_PORT ?? '8080');
  updaterServer(engine, key).listen(port, '0.0.0.0');
  process.stdout.write(`updater listening on ${String(port)} for ${repository}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'updater failed'}\n`);
  process.exit(1);
});
