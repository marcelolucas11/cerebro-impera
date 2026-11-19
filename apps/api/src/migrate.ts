import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));
/** Arbitrary constant: serialises concurrent migrators on the same database. */
const LOCK_KEY = 727_274;

export interface MigrateOptions {
  /** Connection as the database owner. Used only here, never by the API. */
  admin: pg.ClientConfig;
  /** When given, the two service roles are (re)assigned these login passwords. */
  rolePasswords?: { app: string; auth: string; forms?: string };
  log?: (message: string) => void;
}

/**
 * Applies pending migrations in order, each in its own transaction, and
 * refuses to continue if an already-applied file was edited afterwards.
 */
export async function migrate(options: MigrateOptions): Promise<{ applied: string[] }> {
  const log = options.log ?? (() => undefined);
  const client = new pg.Client(options.admin);
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query('CREATE SCHEMA IF NOT EXISTS meta');
    await client.query(`CREATE TABLE IF NOT EXISTS meta.migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);

    const done = new Map<string, string>();
    const existing = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM meta.migrations',
    );
    for (const row of existing.rows) done.set(row.name, row.checksum);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_[a-z0-9_]+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const body = readFileSync(`${MIGRATIONS_DIR}${file}`, 'utf8');
      const checksum = createHash('sha256').update(body).digest('hex');
      const previous = done.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(`migration ${file} was modified after being applied`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(body);
        await client.query('INSERT INTO meta.migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed`, { cause: error });
      }
      applied.push(file);
      log(`applied ${file}`);
    }

    await hardenDatabase(client);
    if (options.rolePasswords) {
      await setRolePassword(client, 'cerebro_app', options.rolePasswords.app);
      await setRolePassword(client, 'cerebro_auth', options.rolePasswords.auth);
      if (options.rolePasswords.forms !== undefined) {
        await setRolePassword(client, 'cerebro_forms', options.rolePasswords.forms);
      }
    }
    return { applied };
  } finally {
    await client.end();
  }
}

/** Nobody but the three service roles may even connect to this database. */
export async function hardenDatabase(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ revoke: string; grant: string }>(
    `SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) AS revoke,
            format('GRANT CONNECT ON DATABASE %I TO cerebro_app, cerebro_auth, cerebro_forms', current_database()) AS grant`,
  );
  const statements = rows[0];
  if (!statements) throw new Error('could not build hardening statements');
  await client.query(statements.revoke);
  await client.query(statements.grant);
}

async function setRolePassword(client: pg.Client, role: string, password: string): Promise<void> {
  await client.query(await rolePasswordStatement(client, role, password));
}

/** The statement that gives a role its password: it carries the verifier, never the password. */
export async function rolePasswordStatement(
  client: pg.ClientBase,
  role: string,
  password: string,
): Promise<string> {
  // ALTER ROLE takes no bind parameters; format() with %I/%L quotes both safely.
  const { rows } = await client.query<{ statement: string }>(
    `SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', $1::text, $2::text) AS statement`,
    [role, scramVerifier(password)],
  );
  const statement = rows[0]?.statement;
  if (statement === undefined) throw new Error('could not build role statement');
  return statement;
}

/** The work factor Postgres itself uses by default. */
const SCRAM_ITERATIONS = 4096;

/**
 * The SCRAM-SHA-256 verifier Postgres keeps for a password (RFC 5802 and 7677),
 * made here so the password never travels in a statement a log could keep.
 * Postgres normalises a password first (SASLprep); for printable ASCII, the only
 * kind the installation makes, that changes nothing, so nothing else is accepted.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16)): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error('a role password must be printable ASCII without spaces');
  }
  const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  return (
    `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}` +
    `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`
  );
}
