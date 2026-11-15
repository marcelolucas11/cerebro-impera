import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PasswordHasher } from './crypto/password.js';
import { Vault } from './crypto/vault.js';
import { closePools, createPools } from './db.js';
import type { Deps } from './deps.js';
import { migrate } from './migrate.js';
import { ensureSetupToken } from './modules/auth.js';
import { initSecrets, readSecrets } from './secrets.js';

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function configDir(): string {
  return process.env.CEREBRO_CONFIG_DIR ?? '/opt/cerebro/config';
}

/** Generates this instance's secrets on first boot. Safe to run every time. */
function commandInitSecrets(): void {
  const { created } = initSecrets(configDir());
  say(created ? `instance secrets created in ${configDir()}` : 'instance secrets already exist');
}

/** Applies database migrations as the database owner and sets the service passwords. */
async function commandMigrate(): Promise<void> {
  const secrets = readSecrets(configDir());
  const host = process.env.CEREBRO_DB_HOST;
  if (host === undefined || host === '') throw new Error('missing CEREBRO_DB_HOST');
  const { applied } = await migrate({
    admin: {
      host,
      port: Number(process.env.CEREBRO_DB_PORT ?? '5432'),
      database: process.env.CEREBRO_DB_NAME ?? 'cerebro',
      user: process.env.CEREBRO_DB_ADMIN_USER ?? 'postgres',
      password: secrets.db.adminPassword,
    },
    rolePasswords: { app: secrets.db.appPassword, auth: secrets.db.authPassword },
    log: say,
  });
  say(applied.length === 0 ? 'database is up to date' : `${applied.length} migration(s) applied`);
}

async function commandServe(): Promise<void> {
  const config = loadConfig();
  const pools = createPools(config.db);
  const deps: Deps = {
    config,
    pools,
    vault: new Vault(config.masterKey),
    hasher: new PasswordHasher(config.argon2),
    now: () => Date.now(),
  };
  const app = await buildApp(deps);

  const { pending } = await ensureSetupToken(deps);
  if (pending) {
    // The token itself is never logged, only where to find it.
    app.log.warn(`first-run setup is pending; the setup token is in ${config.setupTokenFile}`);
  }

  const shutdown = (): void => {
    void app
      .close()
      .then(() => closePools(pools))
      .finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ host: config.listen.host, port: config.listen.port });
}

const commands: Record<string, () => void | Promise<void>> = {
  'init-secrets': commandInitSecrets,
  migrate: commandMigrate,
  serve: commandServe,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  process.stderr.write('usage: cerebro-api <init-secrets | migrate | serve>\n');
  process.exit(2);
}
try {
  await command();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'unexpected failure'}\n`);
  process.exit(1);
}
