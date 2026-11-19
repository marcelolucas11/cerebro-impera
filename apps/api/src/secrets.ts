import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Instance secrets. They are generated on the server the first time it boots
 * and live only in the instance's config directory, outside the repository.
 * There are no default passwords or keys anywhere in the code.
 */
export interface InstanceSecrets {
  version: 1;
  /** 32 random bytes, base64. Encrypts second-factor secrets and secret fields. */
  masterKey: string;
  db: { adminPassword: string; appPassword: string; authPassword: string };
}

const SECRETS_FILE = 'secrets.json';
/** Plain file so the database container can read it as its superuser password. */
const DB_ADMIN_PASSWORD_FILE = 'db-admin-password';

function randomPassword(): string {
  return randomBytes(32).toString('base64url');
}

/** A secret in a file of its own, made only if it is not there yet ('wx': in one step). */
function ensureSecretFile(configDir: string, name: string, content: string): void {
  try {
    writeFileSync(join(configDir, name), content, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Secrets that came after the first ones, made also for installations from
 * before them, never overwritten: the key the API and the updater sign their
 * requests with, and the key of the copies (without it, no copy opens).
 */
function ensureLaterSecrets(configDir: string): void {
  ensureSecretFile(configDir, 'updater-key', randomBytes(32).toString('base64'));
  ensureSecretFile(configDir, 'backup-password', randomPassword());
}

/** Creates the secrets on first boot; never overwrites existing ones. */
export function initSecrets(configDir: string): { created: boolean } {
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  ensureLaterSecrets(configDir);
  const path = join(configDir, SECRETS_FILE);
  if (existsSync(path)) return { created: false };

  const secrets: InstanceSecrets = {
    version: 1,
    masterKey: randomBytes(32).toString('base64'),
    db: {
      adminPassword: randomPassword(),
      appPassword: randomPassword(),
      authPassword: randomPassword(),
    },
  };
  // 'wx' fails if the file appeared meanwhile, so two starters cannot both write.
  writeFileSync(path, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(join(configDir, DB_ADMIN_PASSWORD_FILE), secrets.db.adminPassword, {
    mode: 0o600,
    flag: 'wx',
  });
  chmodSync(path, 0o600);
  return { created: true };
}

export function readSecrets(configDir: string): InstanceSecrets {
  const path = join(configDir, SECRETS_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`instance secrets not found in ${configDir}; run "init-secrets" first`);
  }
  const secrets = parsed as Partial<InstanceSecrets>;
  const db = secrets.db;
  if (
    secrets.version !== 1 ||
    typeof secrets.masterKey !== 'string' ||
    Buffer.from(secrets.masterKey, 'base64').length !== 32 ||
    typeof db?.adminPassword !== 'string' ||
    typeof db.appPassword !== 'string' ||
    typeof db.authPassword !== 'string'
  ) {
    throw new Error('instance secrets file is malformed');
  }
  return secrets as InstanceSecrets;
}
