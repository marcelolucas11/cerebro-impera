import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { digest } from '../src/crypto/tokens.js';
import { Browser, createTestEnv, STRONG_PASSWORD, type TestEnv } from './support/env.js';
import { attempt, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * An authenticator is linked only right after an invite or a reset is used;
 * the live stream checking the session is not activity; and uploads cannot
 * fill the disk: what is still coming counts as taken, every part is checked
 * again, and one person has at most five open at a time.
 */

interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let login: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  login = await connectAs(env, 'cerebro_auth');
  app = await connectAs(env, 'cerebro_app');
});
afterEach(async () => {
  await Promise.all([login, app].map((client) => client.query('ROLLBACK')));
});
afterAll(async () => {
  await Promise.all([login.end(), app.end()]);
  await env.close();
});

describe('linking an authenticator', () => {
  it('happens only right after the invite is used, never with the password alone', async () => {
    const created = await s.owner.browser.post<{ user: { id: string }; invite: { token: string } }>(
      '/api/users',
      { email: 'rita@exemplo.test', name: 'Rita Lopes', role: 'employee' },
    );
    expect(created.status).toBe(200);
    const phone = new Browser(env.app);
    const accepted = await phone.post('/api/auth/invite/accept', {
      token: created.body.invite.token,
      password: STRONG_PASSWORD,
    });
    expect(accepted.status).toBe(200);
    // She stops here. Later, someone with her password tries to link their own authenticator.
    const other = new Browser(env.app);
    const signIn = await other.post<ErrorBody>('/api/auth/login', {
      email: 'rita@exemplo.test',
      password: STRONG_PASSWORD,
    });
    expect(signIn.status).toBe(401);
    expect(signIn.body.error.code).toBe('authenticator_missing');
    expect(other.cookies.size).toBe(0);
    expect((await other.post<ErrorBody>('/api/auth/totp/enroll')).body.error.code).toBe(
      'challenge_required',
    );
    // On the browser that used the invite, linking still works.
    const enrol = await phone.post<{ secret: string }>('/api/auth/totp/enroll');
    expect(enrol.status).toBe(200);
  });

  it('is not offered by a challenge from the password step', async () => {
    const browser = new Browser(env.app);
    const first = await browser.post<{ next: string }>('/api/auth/login', {
      email: s.owner.email,
      password: s.owner.password,
    });
    expect(first.body.next).toBe('totp');
    for (const path of ['/api/auth/totp/enroll', '/api/auth/totp/confirm']) {
      const refused = await browser.post<ErrorBody>(path, { code: '000000' });
      expect(refused.status, path).toBe(401);
      expect(refused.body.error.code, path).toBe('challenge_required');
    }
  });

  it('is held by the database too: only an invite used in the same step makes such a challenge', async () => {
    await login.query('BEGIN');
    const make = () =>
      attempt(
        login,
        `INSERT INTO auth.login_challenges (token_hash, user_id, expires_at, enrol)
         VALUES (sha256(gen_random_uuid()::text::bytea), $1, now() + interval '10 minutes', true)`,
        [s.ana.id],
      );
    expect(await make()).toMatchObject({ ok: false, code: 'CB001' });
    expect(
      await attempt(login, 'UPDATE auth.login_challenges SET enrol = true WHERE user_id = $1', [
        s.ana.id,
      ]),
    ).toMatchObject({ ok: false, code: '42501' });
    await login.query('ROLLBACK');

    await env.admin.query(
      `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
       VALUES (sha256('reset-da-ana'), $1, 'reset', $2, now() + interval '1 day'),
              (sha256('reset-do-bruno'), $3, 'reset', $2, now() + interval '1 day')`,
      [s.ana.id, s.owner.id, s.bruno.id],
    );
    // Someone else's invite, used now, opens nothing for her.
    await login.query('BEGIN');
    await login.query(
      `UPDATE auth.invites SET used_at = now() WHERE token_hash = sha256('reset-do-bruno')`,
    );
    expect(await make()).toMatchObject({ ok: false, code: 'CB001' });
    await login.query('ROLLBACK');
    await login.query('BEGIN');
    await login.query(
      `UPDATE auth.invites SET used_at = now() WHERE token_hash = sha256('reset-da-ana')`,
    );
    expect(await make()).toMatchObject({ ok: true, rowCount: 1 });
    await login.query('ROLLBACK');
    await env.admin.query(
      `DELETE FROM auth.invites WHERE token_hash IN (sha256('reset-da-ana'), sha256('reset-do-bruno'))`,
    );
  });
});

describe('checking the session', () => {
  it('counts as activity only when the person does something', async () => {
    const token = s.bruno.browser.cookies.get('__Host-cerebro_session') ?? '';
    const lastSeen = async (): Promise<number> =>
      (
        await env.admin.query<{ ago: number }>(
          `SELECT extract(epoch FROM now() - last_seen_at)::int AS ago FROM auth.sessions
           WHERE token_hash = sha256($1)`,
          [digest(token)],
        )
      ).rows[0]?.ago ?? -1;
    await env.admin.query(
      `UPDATE auth.sessions SET last_seen_at = now() - interval '10 minutes'
       WHERE token_hash = sha256($1)`,
      [digest(token)],
    );
    const bind = (activity: boolean) =>
      app.query('SELECT ctx_user_id FROM authz.begin_request($1, NULL, $2)', [
        digest(token),
        activity,
      ]);
    expect((await bind(false)).rows).toEqual([{ ctx_user_id: s.bruno.id }]);
    expect(await lastSeen()).toBeGreaterThanOrEqual(599);
    expect((await bind(true)).rowCount).toBe(1);
    expect(await lastSeen()).toBeLessThan(5);
    // The form without the flag is a request by the person, as it always was.
    await env.admin.query(
      `UPDATE auth.sessions SET last_seen_at = now() - interval '10 minutes'
       WHERE token_hash = sha256($1)`,
      [digest(token)],
    );
    expect(
      (await app.query('SELECT 1 FROM authz.begin_request($1, NULL)', [digest(token)])).rowCount,
    ).toBe(1);
    expect(await lastSeen()).toBeLessThan(5);
  });
});

describe('room for uploads', () => {
  const start = (name: string, size: number) =>
    s.ana.browser.post<{ id: string } & ErrorBody>(`/api/items/${s.itemAna}/attachments`, {
      name,
      size,
      type: 'application/octet-stream',
    });
  const free = (bytes: number): void => {
    env.deps.files.freeBytes = () => Promise.resolve(bytes);
  };
  const MB = 1024 * 1024;
  // Half a gigabyte always stays free; here, 20 MB more than that.
  const ROOMY = 532 * MB;
  // The largest file the tests allow.
  const MAX_FILE = 20 * MB;

  it('counts what is still coming as taken, and checks every part again', async () => {
    free(ROOMY);
    const big = await start('grande.bin', 15 * MB);
    expect(big.status, JSON.stringify(big.body)).toBe(200);
    // 15 MB are on their way: another 15 MB no longer fit next to them.
    const second = await start('outro.bin', 15 * MB);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('disk_full');
    // The disk fills by other means while she sends: the next part is refused.
    const small = await start('pequeno.bin', 10);
    expect(small.status).toBe(200);
    free(100 * MB);
    const part = await s.ana.browser.bytes(
      'PUT',
      `/api/uploads/${small.body.id}/parts/0`,
      Buffer.alloc(10, 1),
    );
    expect(part.status).toBe(409);
    free(ROOMY);
    // What already arrived of an upload is no longer counted as coming.
    for (let n = 0; n < 1; n += 1) {
      const sent = await s.ana.browser.bytes(
        'PUT',
        `/api/uploads/${big.body.id}/parts/${String(n)}`,
        Buffer.alloc(8 * MB, 2),
      );
      expect(sent.status).toBe(200);
    }
    // 7 MB still coming: 9 MB more fit, which would not with the whole 15 MB counted.
    const fits = await start('cabe.bin', 9 * MB);
    expect(fits.status, JSON.stringify(fits.body)).toBe(200);
    for (const id of [big.body.id, small.body.id, fits.body.id]) {
      expect((await s.ana.browser.delete(`/api/uploads/${id}`)).status).toBe(200);
    }
  });

  it('lets one person hold at most two of the largest files’ worth at a time', async () => {
    free(10 * ROOMY);
    const first = await start('primeiro.bin', MAX_FILE);
    const second = await start('segundo.bin', MAX_FILE);
    expect([first.status, second.status]).toEqual([200, 200]);
    const third = await start('terceiro.bin', 1);
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('uploads_too_large');
    // Someone else still can.
    const hers = await s.bruno.browser.post<{ id: string }>(
      `/api/items/${s.itemBruno}/attachments`,
      { name: 'dela.bin', size: 1, type: 'application/octet-stream' },
    );
    expect(hers.status).toBe(200);
    expect((await s.bruno.browser.delete(`/api/uploads/${hers.body.id}`)).status).toBe(200);
    for (const id of [first.body.id, second.body.id]) {
      expect((await s.ana.browser.delete(`/api/uploads/${id}`)).status).toBe(200);
    }
  });

  it('lets one person have at most five open at a time', async () => {
    free(ROOMY);
    const open: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const started = await start(`arquivo-${String(n)}.bin`, 10);
      expect(started.status).toBe(200);
      open.push(started.body.id);
    }
    const sixth = await start('sexto.bin', 10);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe('too_many_uploads');
    // Straight at the database, the same line.
    await env.admin.query(`UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1`, [
      s.ana.id,
    ]);
    const token = s.ana.browser.cookies.get('__Host-cerebro_session') ?? '';
    await app.query('BEGIN');
    await app.query('SELECT * FROM authz.begin_request($1, NULL)', [digest(token)]);
    expect(
      await attempt(
        app,
        `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key)
         VALUES (gen_random_uuid(), $1, 'direto.bin', 10, '', '\\x00')`,
        [s.itemAna],
      ),
    ).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
    // Someone else still can.
    const hers = await s.bruno.browser.post<{ id: string }>(
      `/api/items/${s.itemBruno}/attachments`,
      { name: 'dele.bin', size: 10, type: '' },
    );
    expect(hers.status).toBe(200);
    for (const id of [...open, hers.body.id]) {
      await env.admin.query('DELETE FROM app.attachments WHERE id = $1', [id]);
    }
  });
});
