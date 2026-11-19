import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * What the second independent review of the hardening phase asked of the
 * database (D84), tried directly as the services' own roles.
 */

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let login: pg.Client;

const newPerson = async (email: string, status = 'invited'): Promise<string> => {
  const made = await env.admin.query<{ id: string }>(
    `INSERT INTO app.users (email, name, role, status)
     VALUES ($1, 'Pessoa', 'employee', $2) RETURNING id`,
    [email, status],
  );
  const id = made.rows[0]?.id;
  if (id === undefined) throw new Error('no person');
  return id;
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  login = await connectAs(env, 'cerebro_auth');
});
afterEach(async () => {
  await app.query('ROLLBACK');
  await login.query('ROLLBACK');
});
afterAll(async () => {
  await app.end();
  await login.end();
  await env.close();
});

describe('alerts from the login service', () => {
  it('are only its own three kinds, as warnings, with little attached', async () => {
    await login.query('BEGIN');
    expect(
      await attempt(login, `SELECT app.raise_alert('backup_failed', 'info', NULL, '{}')`),
    ).toMatchObject({ ok: false, code: '42501' });
    for (const kind of ['backup_failed', 'permission_changed', 'owner_added']) {
      expect(
        await attempt(login, `SELECT auth.raise_login_alert($1, NULL, '{}')`, [kind]),
        kind,
      ).toMatchObject({ ok: false, code: 'CB001' });
    }
    expect(
      await attempt(login, `SELECT auth.raise_login_alert('login_lockout', NULL, $1)`, [
        JSON.stringify({ filler: 'x'.repeat(9000) }),
      ]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    const raised = await attempt(
      login,
      `SELECT auth.raise_login_alert('device_pending', $1, '{"device_id": "d"}') AS id`,
      [s.ana.id],
    );
    expect(raised.ok).toBe(true);
    await login.query('COMMIT');
    const kept = await env.admin.query<{ kind: string; severity: string; actor_user_id: string }>(
      'SELECT kind, severity, actor_user_id FROM app.security_alerts WHERE id = $1',
      [raised.rows[0]?.id],
    );
    expect(kept.rows[0]).toEqual({
      kind: 'device_pending',
      severity: 'warning',
      actor_user_id: s.ana.id,
    });
  });
});

describe('invites and devices', () => {
  it('does not use an invite past its date', async () => {
    const zeca = await newPerson('zeca2@exemplo.test');
    await env.admin.query(
      `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
       VALUES (sha256('vencido'), $1, 'invite', $2, now() - interval '1 minute')`,
      [zeca, s.owner.id],
    );
    await login.query('BEGIN');
    expect(
      await attempt(login, 'UPDATE auth.invites SET used_at = now() WHERE user_id = $1', [zeca]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    await login.query('ROLLBACK');
    await env.admin.query(
      `UPDATE auth.invites SET expires_at = now() + interval '1 day' WHERE user_id = $1`,
      [zeca],
    );
    await login.query('BEGIN');
    expect(
      await attempt(login, 'UPDATE auth.invites SET used_at = now() WHERE user_id = $1', [zeca]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    await login.query('ROLLBACK');
    await env.admin.query('DELETE FROM app.users WHERE id = $1', [zeca]);
  });

  it('says when a waiting device asked, whatever the login service says', async () => {
    await login.query('BEGIN');
    const asked = await attempt(
      login,
      `INSERT INTO auth.devices (user_id, token_hash, status, created_at)
       VALUES ($1, sha256('aparelho'), 'pending', now() - interval '30 days')
       RETURNING created_at = now() AS now`,
      [s.ana.id],
    );
    expect(asked).toMatchObject({ ok: true, rows: [{ now: true }] });
  });
});

describe('writing an authenticator', () => {
  it('needs a live challenge made for linking one, and only moves the last code forward', async () => {
    const zeca = await newPerson('zeca3@exemplo.test', 'active');
    const write = async (statement: string, values: unknown[] = []) => {
      await login.query('BEGIN');
      const result = await attempt(login, statement, values);
      await login.query('ROLLBACK');
      return result;
    };
    const insert = `INSERT INTO auth.totp (user_id, secret_enc) VALUES ($1, '\\x01')`;
    // No challenge: refused. A sign-in challenge (not for linking): refused.
    expect(await write(insert, [zeca])).toMatchObject({ ok: false, code: 'CB001' });
    await env.admin.query(
      `INSERT INTO auth.login_challenges (token_hash, user_id, expires_at)
       VALUES (sha256('entrada'), $1, now() + interval '5 minutes')`,
      [zeca],
    );
    expect(await write(insert, [zeca])).toMatchObject({ ok: false, code: 'CB001' });
    // A challenge for linking that expired, or was spent before: refused too.
    await env.admin.query(
      `INSERT INTO auth.login_challenges (token_hash, user_id, expires_at, enrol, consumed_at)
       VALUES (sha256('vencido'), $1, now() - interval '1 minute', true, NULL),
              (sha256('gasto'), $1, now() + interval '5 minutes', true, now() - interval '1 minute')`,
      [zeca],
    );
    expect(await write(insert, [zeca])).toMatchObject({ ok: false, code: 'CB001' });
    // A live one: the key goes in, and is confirmed.
    await env.admin.query(
      `INSERT INTO auth.login_challenges (token_hash, user_id, expires_at, enrol)
       VALUES (sha256('vincular'), $1, now() + interval '5 minutes', true)`,
      [zeca],
    );
    await login.query('BEGIN');
    expect(await attempt(login, insert, [zeca])).toMatchObject({ ok: true, rowCount: 1 });
    expect(
      await attempt(
        login,
        'UPDATE auth.totp SET confirmed_at = now(), last_step = 10 WHERE user_id = $1',
        [zeca],
      ),
    ).toMatchObject({ ok: true, rowCount: 1 });
    await login.query('COMMIT');

    // Without the challenge any more: the last code moves forward only, the key stays.
    await env.admin.query('DELETE FROM auth.login_challenges WHERE user_id = $1', [zeca]);
    expect(
      await write('UPDATE auth.totp SET last_step = 11 WHERE user_id = $1', [zeca]),
    ).toMatchObject({
      ok: true,
      rowCount: 1,
    });
    for (const statement of [
      'UPDATE auth.totp SET last_step = 9 WHERE user_id = $1',
      `UPDATE auth.totp SET secret_enc = '\\x02' WHERE user_id = $1`,
      'UPDATE auth.totp SET confirmed_at = NULL WHERE user_id = $1',
      'DELETE FROM auth.totp WHERE user_id = $1',
    ]) {
      expect(await write(statement, [zeca]), statement).toMatchObject({ ok: false, code: 'CB001' });
    }
    // Even with a challenge for linking, a confirmed key is not replaced in place.
    await env.admin.query(
      `INSERT INTO auth.login_challenges (token_hash, user_id, expires_at, enrol)
       VALUES (sha256('de novo'), $1, now() + interval '5 minutes', true)`,
      [zeca],
    );
    expect(
      await write(`UPDATE auth.totp SET secret_enc = '\\x03' WHERE user_id = $1`, [zeca]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    // Taken away only when an invite or reset is used, in the same step.
    await env.admin.query(
      `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
       VALUES (sha256('redefinir'), $1, 'reset', $2, now() + interval '1 day')`,
      [zeca, s.owner.id],
    );
    await login.query('BEGIN');
    await login.query('UPDATE auth.invites SET used_at = now() WHERE user_id = $1', [zeca]);
    expect(await attempt(login, 'DELETE FROM auth.totp WHERE user_id = $1', [zeca])).toMatchObject({
      ok: true,
      rowCount: 1,
    });
    await login.query('ROLLBACK');
    await env.admin.query('DELETE FROM app.users WHERE id = $1', [zeca]);
  });
});

describe('the first owner’s authenticator', () => {
  it('goes in without a challenge only while the installation is being set up', async () => {
    const fresh = await createTestEnv();
    const auth = await connectAs(fresh, 'cerebro_auth');
    try {
      const owner = (
        await fresh.admin.query<{ id: string }>(
          `INSERT INTO app.users (email, name, role, status)
           VALUES ('dona@exemplo.test', 'Dona', 'owner', 'active') RETURNING id`,
        )
      ).rows[0]?.id;
      const insert = async () => {
        await auth.query('BEGIN');
        const result = await attempt(
          auth,
          `INSERT INTO auth.totp (user_id, secret_enc, confirmed_at) VALUES ($1, '\\x01', now())`,
          [owner],
        );
        await auth.query('ROLLBACK');
        return result;
      };
      expect(await insert()).toMatchObject({ ok: true, rowCount: 1 });
      await fresh.admin.query('UPDATE app.instance_settings SET setup_completed_at = now()');
      expect(await insert()).toMatchObject({ ok: false, code: 'CB001' });
    } finally {
      await auth.end();
      await fresh.close();
    }
  });
});

describe('uploads', () => {
  it('count only what is moving as space taken, and one person’s reservations apart', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const before = await attempt(app, 'SELECT pending, mine, mine_pending FROM app.uploads_open()');
    expect(before.rows[0]).toEqual({ pending: '0', mine: 0, mine_pending: '0' });
    await app.query('COMMIT');
    const made = await env.admin.query<{ id: string }>(
      `INSERT INTO app.attachments (id, item_id, name, size, declared_type, wrapped_key, created_by, created_at)
       VALUES (gen_random_uuid(), $1, 'a.pdf', 1000, 'application/pdf', '\\x00', $2, now()),
              (gen_random_uuid(), $1, 'b.pdf', 8388708, 'application/pdf', '\\x00', $2, now() - interval '1 hour'),
              (gen_random_uuid(), $1, 'c.pdf', 4000, 'application/pdf', '\\x00', $3, now())
       RETURNING id`,
      [s.itemAna, s.ana.id, s.bruno.id],
    );
    // b was started an hour ago and nothing came since: it holds no space.
    const stale = made.rows[1]?.id;
    expect(await bind(app, s.ana)).toBe(true);
    expect(
      (await attempt(app, 'SELECT pending, mine, mine_pending FROM app.uploads_open()')).rows[0],
    ).toEqual({
      pending: '5000',
      mine: 2,
      mine_pending: '1000',
    });
    await app.query('COMMIT');
    await env.admin.query(
      `INSERT INTO app.attachment_parts (attachment_id, n, size) VALUES ($1, 0, 8388608)`,
      [stale],
    );
    expect(await bind(app, s.ana)).toBe(true);
    expect(
      (await attempt(app, 'SELECT pending, mine, mine_pending FROM app.uploads_open()')).rows[0],
    ).toEqual({
      pending: '5100',
      mine: 2,
      mine_pending: '1100',
    });
    await app.query('COMMIT');
    await env.admin.query('DELETE FROM app.attachments WHERE id = ANY($1::uuid[])', [
      made.rows.map((row) => row.id),
    ]);
  });
});

describe('owners and the first account', () => {
  it('change only under READ COMMITTED', async () => {
    const zeca = await newPerson('zeca4@exemplo.test');
    await env.admin.query(
      `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
       VALUES (sha256('isolamento'), $1, 'invite', $2, now() + interval '1 day')`,
      [zeca, s.owner.id],
    );
    const activate = async (isolation: string) => {
      await login.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await login.query('UPDATE auth.invites SET used_at = now() WHERE user_id = $1', [zeca]);
      const result = await attempt(login, `UPDATE app.users SET status = 'active' WHERE id = $1`, [
        zeca,
      ]);
      await login.query('ROLLBACK');
      return result;
    };
    expect(await activate('REPEATABLE READ')).toMatchObject({ ok: false, code: 'CB001' });
    expect(await activate('SERIALIZABLE')).toMatchObject({ ok: false, code: 'CB001' });
    expect(await activate('READ COMMITTED')).toMatchObject({ ok: true, rowCount: 1 });
    await env.admin.query('DELETE FROM app.users WHERE id = $1', [zeca]);
  });
});

describe('the record', () => {
  it('takes what an update did only from an owner, and a sensitive list opened only from who can open it', async () => {
    const say = async (who: typeof s.ana, statement: string, values: unknown[]) => {
      expect(await bind(app, who)).toBe(true);
      const result = await attempt(app, statement, values);
      await app.query('ROLLBACK');
      return result;
    };
    const update = `SELECT audit.record('update.applied', 'update', 'job-1', '{}')`;
    expect(await say(s.ana, update, [])).toMatchObject({ ok: false, code: 'CB001' });
    expect(await say(s.marta, update, [])).toMatchObject({ ok: false, code: 'CB001' });
    expect(await say(s.owner, update, [])).toMatchObject({ ok: true });
    const viewed = `SELECT audit.record('list.sensitive_viewed', 'list', $1)`;
    expect(await say(s.ana, viewed, [s.dinheiro])).toMatchObject({ ok: false, code: 'CB001' });
    expect(await say(s.ana, viewed, ['nada'])).toMatchObject({ ok: false, code: 'CB001' });
    expect(await say(s.ana, viewed, ['00000000-0000-4000-8000-000000000000'])).toMatchObject({
      ok: false,
      code: 'CB001',
    });
    expect(await say(s.owner, viewed, [s.dinheiro])).toMatchObject({ ok: true });
    // Said of a list, naming one: not of anything else, nor of nothing.
    expect(
      await say(s.owner, `SELECT audit.record('list.sensitive_viewed', 'item', $1)`, [s.dinheiro]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    expect(
      await say(s.owner, `SELECT audit.record('list.sensitive_viewed', 'list', NULL)`, []),
    ).toMatchObject({ ok: false, code: 'CB001' });
    // Other entries, as before, from whoever writes them.
    expect(
      await say(s.ana, `SELECT audit.record('attachment.downloaded', 'attachment', 'a')`, []),
    ).toMatchObject({ ok: true });
  });
});

describe('a list that changes', () => {
  it('is announced, so open pages read the structure again', async () => {
    const listener = await connectAs(env, 'cerebro_app');
    const heard: string[] = [];
    listener.on('notification', (message) => {
      if (message.payload !== undefined) heard.push(message.payload);
    });
    await listener.query('LISTEN cerebro_live');
    await env.admin.query('UPDATE app.lists SET position = position WHERE id = $1', [s.perfis]);
    await env.admin.query('UPDATE app.lists SET is_sensitive = true WHERE id = $1', [s.perfis]);
    await env.admin.query('UPDATE app.lists SET is_sensitive = false WHERE id = $1', [s.perfis]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await listener.end();
    expect(heard.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      { l: s.perfis },
      { l: s.perfis },
    ]);
  });
});
