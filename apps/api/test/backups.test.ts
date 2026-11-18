import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inTransaction } from '../src/db.js';
import { checkBackups, problems, type BackupState } from '../src/modules/backups.js';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The copies, as the backup service reports them: shown to whoever sees the
 * audit trail, and turned into alerts for the owners once a day per kind, by
 * the routine only.
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2030, 0, 1, 12, 0, 0); // the test environment's clock

const lastBackup = {
  startedAt: new Date(NOW - 9 * HOUR).toISOString(),
  finishedAt: new Date(NOW - 9 * HOUR + 60_000).toISOString(),
  ok: true,
  snapshot: 'a1b2c3d4',
  bytes: 1024,
  problem: null,
};
const lastRestoreTest = {
  at: new Date(NOW - 20 * 24 * HOUR).toISOString(),
  ok: true,
  people: 5,
  problem: null,
};
const good: BackupState = {
  lastBackup: {
    startedAt: new Date(NOW - 9 * HOUR).toISOString(),
    finishedAt: new Date(NOW - 9 * HOUR + 60_000).toISOString(),
    ok: true,
    snapshot: 'a1b2c3d4',
    bytes: 1024,
    problem: null,
  },
  lastSuccessAt: new Date(NOW - 9 * HOUR + 60_000).toISOString(),
  lastRestoreTest: {
    at: new Date(NOW - 20 * 24 * HOUR).toISOString(),
    ok: true,
    people: 5,
    problem: null,
  },
  nextRunAt: new Date(NOW + 15 * HOUR).toISOString(),
};

let scratch: string;
let file: string;
let env: TestEnv;
let bare: TestEnv;
let s: Scenario;
let app: pg.Client;

const write = (state: unknown): void => {
  writeFileSync(file, typeof state === 'string' ? state : JSON.stringify(state));
};
const alerts = async (kind: string): Promise<number> =>
  Number(
    (
      await env.admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM app.security_alerts WHERE kind = $1',
        [kind],
      )
    ).rows[0]?.n ?? 0,
  );
const routine = (): Promise<number> =>
  inTransaction(env.deps.pools.app, (db) => checkBackups(db, env.deps));

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'cerebro-backup-'));
  file = join(scratch, 'backup.json');
  write(good);
  env = await createTestEnv({ backupStatusFile: file });
  s = await buildScenario(env);
  bare = await createTestEnv();
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
  await bare.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('the copies on the security page', () => {
  it('are shown to whoever sees the audit trail, and to nobody else', async () => {
    const shown = await s.owner.browser.get<
      BackupState & { configured: boolean; readable: boolean }
    >('/api/backups');
    expect(shown.status).toBe(200);
    expect(shown.body).toMatchObject({
      configured: true,
      readable: true,
      lastSuccessAt: good.lastSuccessAt,
    });
    for (const person of [s.marta, s.ana]) {
      expect((await person.browser.get('/api/backups')).status, person.id).toBe(403);
    }
  });

  it('say when there is no backup service, or its situation cannot be read', async () => {
    const alone = await buildScenario(bare);
    expect((await alone.owner.browser.get('/api/backups')).body).toMatchObject({
      configured: false,
      lastBackup: null,
    });
    write('isto não é json');
    expect((await s.owner.browser.get('/api/backups')).body).toMatchObject({
      configured: true,
      readable: false,
    });
    write(good);
  });
});

describe('alerts about the copies', () => {
  it('name what is wrong: a failed copy, no good copy for over a day, a failed restore test', () => {
    expect(problems(good, NOW)).toEqual([]);
    expect(problems({ ...good, lastBackup: null, lastSuccessAt: null }, NOW)).toEqual([]);
    const failed = { ...good, lastBackup: { ...lastBackup, ok: false, problem: 'x' } };
    expect(problems(failed, NOW)).toEqual(['backup_failed']);
    expect(problems(failed, NOW + 30 * HOUR)).toEqual(['backup_failed', 'backup_stale']);
    expect(problems(good, NOW + 18 * HOUR)).toEqual(['backup_stale']);
    expect(problems({ ...good, lastRestoreTest: { ...lastRestoreTest, ok: false } }, NOW)).toEqual([
      'restore_test_failed',
    ]);
    expect(problems(null, NOW)).toEqual(['backup_stale']);
  });

  it('are raised by the routine once a day per kind, with what went wrong', async () => {
    expect(await routine()).toBe(0);
    write({
      ...good,
      lastBackup: {
        ...lastBackup,
        ok: false,
        problem: 'Não foi possível gravar a cópia no destino.',
      },
    });
    expect(await routine()).toBe(1);
    expect(await routine()).toBe(0);
    expect(await alerts('backup_failed')).toBe(1);
    const metadata = (
      await env.admin.query<{ metadata: { problem: string } }>(
        "SELECT metadata FROM app.security_alerts WHERE kind = 'backup_failed'",
      )
    ).rows[0]?.metadata;
    expect(metadata?.problem).toBe('Não foi possível gravar a cópia no destino.');
    // A day later the same problem warns again.
    await env.admin.query("UPDATE app.security_alerts SET at = at - interval '25 hours'");
    expect(await routine()).toBe(1);
    write(good);
  });

  it('cannot be raised from a request, nor of any other kind, at the database', async () => {
    expect(await bind(app, s.owner)).toBe(true);
    expect(
      await attempt(app, "SELECT app.raise_backup_alert('backup_failed', '{}')"),
    ).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');
    const other = await app.query("SELECT app.raise_backup_alert('device_approved', '{}')").then(
      () => 'ok',
      (error: unknown) => (error as { code?: string }).code,
    );
    expect(other).toBe('22023');
    expect(await alerts('device_approved')).toBe(0);
  });
});
