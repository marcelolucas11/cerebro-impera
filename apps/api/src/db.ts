import pg from 'pg';
import type { DbConfig } from './config.js';

export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface Sql {
  text: string;
  values: unknown[];
}

/**
 * Tagged template for SQL. Interpolated values become bind parameters
 * ($1, $2, ...) and are never concatenated into the statement, so user input
 * cannot change the shape of a query.
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): Sql {
  let text = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    text += `$${i + 1}${strings[i + 1] ?? ''}`;
  }
  return { text, values };
}

export async function rows<T>(db: Queryable, query: Sql): Promise<T[]> {
  const result = await db.query(query.text, query.values);
  return result.rows as T[];
}

export async function one<T>(db: Queryable, query: Sql): Promise<T | undefined> {
  return (await rows<T>(db, query))[0];
}

export async function run(db: Queryable, query: Sql): Promise<number> {
  const result = await db.query(query.text, query.values);
  return result.rowCount ?? 0;
}

export interface Pools {
  /** Authenticated requests. Sees only what row-level security allows. */
  app: pg.Pool;
  /** Login flow. Credential tables only. */
  auth: pg.Pool;
}

export function createPools(db: DbConfig, overrides: { max?: number } = {}): Pools {
  const shared = {
    host: db.host,
    port: db.port,
    database: db.database,
    max: overrides.max ?? 10,
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'cerebro-api',
  };
  return {
    app: new pg.Pool({ ...shared, user: 'cerebro_app', password: db.appPassword }),
    auth: new pg.Pool({ ...shared, user: 'cerebro_auth', password: db.authPassword }),
  };
}

export async function closePools(pools: Pools): Promise<void> {
  await Promise.all([pools.app.end(), pools.auth.end()]);
}

export async function inTransaction<T>(pool: pg.Pool, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    // A connection whose rollback failed is in an unknown state: discard it.
    client.release(broken);
  }
}
