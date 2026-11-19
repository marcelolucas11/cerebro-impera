import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rolePasswordStatement, scramVerifier } from '../src/migrate.js';
import { createTestEnv, type TestEnv } from './support/env.js';

/*
 * The passwords of the service roles reach the database already turned into the
 * verifier Postgres keeps, so no statement (and no log of statements) holds them.
 */

let env: TestEnv;
const role = `cerebro_check_${randomBytes(4).toString('hex')}`;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.admin.query(`DROP ROLE IF EXISTS ${role}`);
  await env.close();
});

const stored = async (name: string): Promise<string> => {
  const found = await env.admin.query<{ rolpassword: string }>(
    'SELECT rolpassword FROM pg_authid WHERE rolname = $1',
    [name],
  );
  return found.rows[0]?.rolpassword ?? '';
};

describe('a service role password', () => {
  it('is the same verifier Postgres would make from the password', async () => {
    const password = randomBytes(18).toString('base64url');
    const client = await env.admin.connect();
    try {
      await client.query(`SET password_encryption = 'scram-sha-256'`);
      await client.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    } finally {
      client.release();
    }
    const made = await stored(role);
    const salt = /^SCRAM-SHA-256\$4096:([^$]+)\$/.exec(made)?.[1];
    expect(salt).toBeDefined();
    expect(scramVerifier(password, Buffer.from(salt ?? '', 'base64'))).toBe(made);
    // Another password, or the same with another salt, gives another verifier.
    expect(scramVerifier(`${password}x`, Buffer.from(salt ?? '', 'base64'))).not.toBe(made);
    expect(scramVerifier(password)).not.toBe(made);
  });

  it('goes to the database only as its verifier, and opens a connection only with it', async () => {
    const password = randomBytes(18).toString('base64url');
    const client = await env.admin.connect();
    try {
      const statement = await rolePasswordStatement(client, role, password);
      expect(statement).not.toContain(password);
      expect(statement).toMatch(
        /^ALTER ROLE cerebro_check_[0-9a-f]{8} WITH LOGIN PASSWORD 'SCRAM-SHA-256\$4096:/,
      );
      await client.query(statement);
    } finally {
      client.release();
    }
    const config = { ...env.dbConfig, user: role };
    const right = new pg.Client({ ...config, password });
    await right.connect();
    expect((await right.query<{ me: string }>('SELECT current_user AS me')).rows[0]?.me).toBe(role);
    await right.end();
    const wrong = new pg.Client({ ...config, password: `${password}x` });
    await expect(wrong.connect()).rejects.toThrow(/password authentication failed/);
  });

  it('is what the installation keeps for the API’s roles', async () => {
    for (const name of ['cerebro_app', 'cerebro_auth', 'cerebro_forms']) {
      expect(await stored(name), name).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]{24}\$/);
    }
  });

  it('takes nothing that Postgres would first rewrite', () => {
    for (const password of ['com espaco', 'acentuação', 'tab\there', '']) {
      expect(() => scramVerifier(password), password).toThrow('printable ASCII');
    }
  });
});
