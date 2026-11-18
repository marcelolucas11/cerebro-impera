/*
 * Starts a throwaway installation for the browser tests: a fresh database,
 * fresh secrets, and the real API serving the real page, through the same
 * commands a server runs in production (init-secrets, migrate, serve).
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import pg from 'pg';
import { startFakeUpdater } from './fake-updater.mjs';

const adminUrl = process.env.TEST_PG_ADMIN_URL;
if (!adminUrl) {
  process.stderr.write(
    'TEST_PG_ADMIN_URL is required: the superuser URL of a disposable PostgreSQL 16+ server.\n',
  );
  process.exit(1);
}

const port = process.env.CEREBRO_E2E_PORT ?? '3917';
const work = join(tmpdir(), 'cerebro-e2e');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true, mode: 0o700 });
const configDir = join(work, 'config');

const admin = new URL(adminUrl);
const database = `cerebro_e2e_${randomBytes(4).toString('hex')}`;
const maintenance = new pg.Client({ connectionString: adminUrl });
await maintenance.connect();
await maintenance.query(`CREATE DATABASE "${database}"`);
await maintenance.end();

const cli = resolve(import.meta.dirname, '../../api/dist/cli.js');
const env = {
  ...process.env,
  CEREBRO_ENV: 'development',
  CEREBRO_CONFIG_DIR: configDir,
  CEREBRO_DB_HOST: admin.hostname,
  CEREBRO_DB_PORT: admin.port || '5432',
  CEREBRO_DB_NAME: database,
  CEREBRO_DB_ADMIN_USER: decodeURIComponent(admin.username),
  CEREBRO_PUBLIC_ORIGIN: `http://localhost:${port}`,
  CEREBRO_HOST: '127.0.0.1',
  CEREBRO_PORT: port,
  CEREBRO_WEB_ROOT: resolve(import.meta.dirname, '../dist'),
  CEREBRO_FILES_DIR: join(work, 'files'),
  // No antivirus in the browser tests: files are kept, marked as not checked.
  CEREBRO_ANTIVIRUS: 'off',
  // A stand-in updater, on the next port, signed like the real one.
  CEREBRO_VERSION: '1.4.0',
  CEREBRO_UPDATER_URL: `http://127.0.0.1:${String(Number(port) + 1)}`,
};
mkdirSync(env.CEREBRO_FILES_DIR, { recursive: true, mode: 0o700 });

function run(command) {
  const result = spawnSync(process.execPath, [cli, command], { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('init-secrets');
// The disposable server already has its own superuser password: use that one.
const secretsFile = join(configDir, 'secrets.json');
const secrets = JSON.parse(readFileSync(secretsFile, 'utf8'));
secrets.db.adminPassword = decodeURIComponent(admin.password);
writeFileSync(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
run('migrate');

const updaterKey = randomBytes(32);
writeFileSync(join(configDir, 'updater-key'), updaterKey.toString('base64'), { mode: 0o600 });
const fakeUpdater = startFakeUpdater(updaterKey, Number(port) + 1);

const databaseUrl = new URL(adminUrl);
databaseUrl.pathname = `/${database}`;
writeFileSync(
  join(work, 'state.json'),
  JSON.stringify({
    databaseUrl: databaseUrl.toString(),
    setupTokenFile: join(configDir, 'setup-token'),
  }),
  { mode: 0o600 },
);

const server = spawn(process.execPath, [cli, 'serve'], { env, stdio: 'inherit' });

async function cleanUp() {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    await client.connect();
    await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  } catch {
    // A leftover test database on a disposable server is harmless.
  } finally {
    await client.end().catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    fakeUpdater.close();
    server.kill('SIGTERM');
  });
}
server.on('exit', (code) => {
  void cleanUp().then(() => process.exit(stopping ? 0 : (code ?? 1)));
});
