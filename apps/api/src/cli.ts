import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { PasswordHasher } from './crypto/password.js';
import { Vault } from './crypto/vault.js';
import { closePools, createPools, inTransaction } from './db.js';
import type { Deps } from './deps.js';
import { clamdScanner, noScanner } from './files/scanner.js';
import { httpUpdater } from './updates/client.js';
import { FileStore } from './files/store.js';
import { migrate } from './migrate.js';
import { ensureSetupToken } from './modules/auth.js';
import { purgeAttachments, resumeScans } from './modules/attachments.js';
import { automationsDue, purgeAutomationRuns } from './modules/automations.js';
import { checkBackups } from './modules/backups.js';
import { makeWeeklyReport } from './modules/reports.js';
import { purgeTrash } from './modules/structure.js';
import { notifyDue } from './modules/notifications.js';
import { join } from 'node:path';
import { serveForms } from './forms/main.js';
import {
  FORMS_DIR,
  initSecrets,
  readAdminPassword,
  readFormsSecrets,
  readSecrets,
} from './secrets.js';

function say(message: string): void {
  process.stdout.write(`${message}\n`);
}

function configDir(): string {
  return process.env.CEREBRO_CONFIG_DIR ?? '/opt/cerebro/config';
}

/** Generates this instance's secrets on first boot. Safe to run every time. */
function commandInitSecrets(): void {
  const { created, moved } = initSecrets(configDir());
  if (moved.length > 0) say(`moved into their folders: ${moved.join(', ')}`);
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
      password: readAdminPassword(configDir()),
    },
    rolePasswords: {
      app: secrets.db.appPassword,
      auth: secrets.db.authPassword,
      forms: readFormsSecrets(join(configDir(), FORMS_DIR)).dbPassword,
    },
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
    files: new FileStore(config.files.dir),
    scanner:
      config.antivirus === null
        ? null
        : config.antivirus.kind === 'off'
          ? noScanner
          : clamdScanner(config.antivirus.host, config.antivirus.port),
    updater: config.updater === null ? null : httpUpdater(config.updater.url, config.updater.key),
  };
  const app = await buildApp(deps);

  const { pending } = await ensureSetupToken(deps);
  if (pending) {
    // The token itself is never logged, only where to find it.
    app.log.warn(`first-run setup is pending; the setup token is in ${config.setupTokenFile}`);
  }

  // What has been in the trash for longer than allowed is removed for good: once
  // at start and then every hour. The database decides what is old enough.
  const purge = (): void => {
    inTransaction(pools.app, purgeTrash)
      .then(async (purged) => {
        if (purged > 0) app.log.info({ purged }, 'items removed from the trash for good');
        // What is due today or late reminds whoever it is with.
        const reminded = await inTransaction(pools.app, notifyDue);
        if (reminded > 0) app.log.info({ reminded }, 'due date reminders made');
        const ruled = await inTransaction(pools.app, automationsDue);
        if (ruled > 0) app.log.info({ ruled }, 'rules on due dates applied');
        const runs = await inTransaction(pools.app, purgeAutomationRuns);
        if (runs > 0) app.log.info({ runs }, 'old automation runs removed');
        // Monday's first run writes the report of the week that ended.
        const report = await inTransaction(pools.app, makeWeeklyReport);
        if (report > 0) app.log.info('weekly report made');
        // Copies that failed or are late warn the owners, once a day per kind.
        const backupAlerts = await inTransaction(pools.app, (db) => checkBackups(db, deps));
        if (backupAlerts > 0) app.log.warn({ backupAlerts }, 'backup alerts raised');
        const files = await purgeAttachments(deps);
        if (files > 0) app.log.info({ files }, 'attachments removed for good');
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'emptying the trash failed; it will be tried again');
      });
    // Whatever is still waiting for the antivirus: after a restart, or after it was down.
    resumeScans(deps, (error) => {
      app.log.error({ err: error }, 'an attachment could not be checked; it will be tried again');
    }).catch((error: unknown) => {
      app.log.error({ err: error }, 'could not resume antivirus checks');
    });
  };
  purge();
  const purgeTimer = setInterval(purge, 60 * 60 * 1000);
  purgeTimer.unref();

  const shutdown = (): void => {
    clearInterval(purgeTimer);
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
  // The public forms, on an address of their own: only shows and sends forms.
  forms: serveForms,
};

const command = commands[process.argv[2] ?? ''];
if (!command) {
  process.stderr.write('usage: cerebro-api <init-secrets | migrate | serve | forms>\n');
  process.exit(2);
}
try {
  await command();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'unexpected failure'}\n`);
  process.exit(1);
}
