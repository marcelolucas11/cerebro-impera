import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Instance secrets. They are generated on the server the first time it boots
 * and live only in the instance's config volume, outside the repository.
 * There are no default passwords or keys anywhere in the code.
 *
 * Each service mounts only the folder of the secrets it uses:
 *
 *   api/      the instance key, the two passwords the API connects with, the setup token
 *   db/       the database administrator's password (the database, migrations, copies)
 *   updater/  the key the API and the updater sign their requests with
 *   backup/   the key of the copies, and where they go (rclone.conf, put by the maintainer)
 *   forms/    the forms service's own password and the key of its stamp
 *
 * So the API that faces the internet never holds the administrator's password,
 * and the copies' key never sits next to what it protects in the same service.
 */
export const API_DIR = 'api';
export const DB_DIR = 'db';
export const UPDATER_DIR = 'updater';
export const BACKUP_DIR = 'backup';
export const FORMS_DIR = 'forms';

export interface InstanceSecrets {
  version: 2;
  /** 32 random bytes, base64. Encrypts second-factor secrets and secret fields. */
  masterKey: string;
  db: { appPassword: string; authPassword: string };
}

const SECRETS_FILE = join(API_DIR, 'secrets.json');
const ADMIN_PASSWORD_FILE = join(DB_DIR, 'admin-password');
export const UPDATER_KEY_FILE = join(UPDATER_DIR, 'updater-key');
export const SETUP_TOKEN_FILE = join(API_DIR, 'setup-token');

function randomPassword(): string {
  return randomBytes(32).toString('base64url');
}

/** Writes a new private file; false, and nothing written, if it is already there ('wx'). */
function createOnly(path: string, content: string): boolean {
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

/** A secret in a file of its own, made only if it is not there yet. */
function ensureSecretFile(configDir: string, name: string, content: string): void {
  createOnly(join(configDir, name), content);
}

/**
 * Installations from before the folders kept every secret at the top of the
 * volume, the administrator's password inside the API's own file. They move
 * into their folders on the next start, once; nothing is generated anew.
 */
function moveOldLayout(configDir: string): string[] {
  const moved: string[] = [];
  const old = join(configDir, 'secrets.json');
  if (existsSync(old) && !existsSync(join(configDir, SECRETS_FILE))) {
    const parsed = JSON.parse(readFileSync(old, 'utf8')) as {
      version?: unknown;
      masterKey?: unknown;
      db?: { adminPassword?: unknown; appPassword?: unknown; authPassword?: unknown };
    };
    const { masterKey, db } = parsed;
    if (
      parsed.version !== 1 ||
      typeof masterKey !== 'string' ||
      typeof db?.adminPassword !== 'string' ||
      typeof db.appPassword !== 'string' ||
      typeof db.authPassword !== 'string'
    ) {
      throw new Error('the old instance secrets file is malformed; nothing was moved');
    }
    const current: InstanceSecrets = {
      version: 2,
      masterKey,
      db: { appPassword: db.appPassword, authPassword: db.authPassword },
    };
    ensureSecretFile(configDir, ADMIN_PASSWORD_FILE, db.adminPassword);
    writeFileSync(join(configDir, SECRETS_FILE), JSON.stringify(current, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    rmSync(old);
    rmSync(join(configDir, 'db-admin-password'), { force: true });
    moved.push('secrets.json', 'db-admin-password');
  }
  for (const [from, to] of [
    ['updater-key', UPDATER_KEY_FILE],
    ['backup-password', join(BACKUP_DIR, 'backup-password')],
    ['rclone.conf', join(BACKUP_DIR, 'rclone.conf')],
    ['setup-token', SETUP_TOKEN_FILE],
  ] as const) {
    if (existsSync(join(configDir, from)) && !existsSync(join(configDir, to))) {
      renameSync(join(configDir, from), join(configDir, to));
      moved.push(from);
    }
  }
  return moved;
}

/** Creates the secrets on first boot; never overwrites existing ones. */
export function initSecrets(configDir: string): { created: boolean; moved: string[] } {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  for (const folder of [API_DIR, DB_DIR, UPDATER_DIR, BACKUP_DIR, FORMS_DIR]) {
    mkdirSync(join(configDir, folder), { recursive: true, mode: 0o700 });
  }
  const moved = moveOldLayout(configDir);

  // Secrets that came after the first ones, made also for installations from
  // before them, never overwritten.
  ensureSecretFile(configDir, UPDATER_KEY_FILE, randomBytes(32).toString('base64'));
  ensureSecretFile(configDir, join(BACKUP_DIR, 'backup-password'), randomPassword());
  ensureSecretFile(configDir, join(FORMS_DIR, 'db-password'), randomPassword());
  ensureSecretFile(configDir, join(FORMS_DIR, 'form-key'), randomBytes(32).toString('base64'));

  // Both halves are made in one step each ('wx' fails if the file is there): two starters
  // cannot both write, and nothing is looked at first and written later.
  const secrets: InstanceSecrets = {
    version: 2,
    masterKey: randomBytes(32).toString('base64'),
    db: { appPassword: randomPassword(), authPassword: randomPassword() },
  };
  const adminPath = join(configDir, ADMIN_PASSWORD_FILE);
  const secretsPath = join(configDir, SECRETS_FILE);
  const madeAdmin = createOnly(adminPath, randomPassword());
  const madeSecrets = createOnly(secretsPath, JSON.stringify(secrets, null, 2) + '\n');
  if (madeAdmin !== madeSecrets) {
    // A new administrator password next to an existing database (or the other
    // way round) would lock the installation out of its own data: undo, and say so.
    rmSync(madeAdmin ? adminPath : secretsPath);
    throw new Error(
      `only one of ${SECRETS_FILE} and ${ADMIN_PASSWORD_FILE} exists; restore the other from a copy`,
    );
  }
  return { created: madeSecrets, moved };
}

/** The API's own secrets: the instance key and the passwords it connects with. */
export function readSecrets(configDir: string): InstanceSecrets {
  const path = join(configDir, SECRETS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`instance secrets not found in ${configDir}; run "init-secrets" first`);
  }
  const secrets = parsed as Partial<InstanceSecrets> & { db?: Record<string, unknown> };
  const db = secrets.db;
  if (
    secrets.version !== 2 ||
    typeof secrets.masterKey !== 'string' ||
    Buffer.from(secrets.masterKey, 'base64').length !== 32 ||
    typeof db?.appPassword !== 'string' ||
    typeof db.authPassword !== 'string' ||
    'adminPassword' in db
  ) {
    throw new Error('instance secrets file is malformed');
  }
  return secrets as InstanceSecrets;
}

/** The database administrator's password, for migrations only. */
export function readAdminPassword(configDir: string): string {
  let password: string;
  try {
    password = readFileSync(join(configDir, ADMIN_PASSWORD_FILE), 'utf8').trim();
  } catch {
    throw new Error(`the database administrator's password is not in ${join(configDir, DB_DIR)}`);
  }
  if (password.length < 20) throw new Error("the database administrator's password is malformed");
  return password;
}

export interface FormsSecrets {
  dbPassword: string;
  formKey: Buffer;
}

const FORMS_FILES = ['db-password', 'form-key'];

/**
 * Reads the forms service's own secrets from its folder. If the folder holds
 * anything else, the service was given more of the configuration than its own
 * (a mount without the subfolder): it refuses to start rather than run with it.
 */
export function readFormsSecrets(formsDir: string): FormsSecrets {
  let entries: string[];
  let dbPassword: string;
  let formKey: Buffer;
  try {
    entries = readdirSync(formsDir);
    dbPassword = readFileSync(join(formsDir, 'db-password'), 'utf8').trim();
    formKey = Buffer.from(readFileSync(join(formsDir, 'form-key'), 'utf8').trim(), 'base64');
  } catch {
    throw new Error(`the forms secrets are not in ${formsDir}; run "init-secrets" first`);
  }
  if (entries.some((entry) => !FORMS_FILES.includes(entry))) {
    throw new Error(
      `${formsDir} holds more than the forms secrets; mount only the "forms" folder of the configuration`,
    );
  }
  if (dbPassword.length < 20 || formKey.length !== 32) {
    throw new Error('the forms secrets are malformed');
  }
  return { dbPassword, formKey };
}
