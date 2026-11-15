import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { migrate } from '../../src/migrate.js';

export interface TestDatabase {
  /** Superuser connection string to the maintenance database. */
  adminUrl: string;
  /** Fully migrated database that each test file clones. */
  template: string;
  appPassword: string;
  authPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabase: TestDatabase;
  }
}

/**
 * Runs once per test run. Needs a real PostgreSQL 16+ server: the security
 * tests exercise row-level security, roles and triggers, which cannot be
 * faked. Point TEST_PG_ADMIN_URL at a throwaway server's superuser, e.g.
 *   postgres://postgres:<password>@127.0.0.1:5432/postgres
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_PG_ADMIN_URL;
  if (adminUrl === undefined || adminUrl === '') {
    throw new Error('TEST_PG_ADMIN_URL is required to run the API tests (see README)');
  }
  const suffix = randomBytes(4).toString('hex');
  const template = `cerebro_test_${suffix}_template`;
  const prefix = `cerebro_test_${suffix}_`;
  const appPassword = randomBytes(18).toString('base64url');
  const authPassword = randomBytes(18).toString('base64url');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${template}"`);

  const url = new URL(adminUrl);
  url.pathname = `/${template}`;
  await migrate({
    admin: { connectionString: url.toString() },
    rolePasswords: { app: appPassword, auth: authPassword },
  });

  project.provide('testDatabase', { adminUrl, template, appPassword, authPassword });

  return async () => {
    const leftovers = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname LIKE $1',
      [`${prefix}%`],
    );
    for (const { datname } of leftovers.rows) {
      await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
    await admin.end();
  };
}
