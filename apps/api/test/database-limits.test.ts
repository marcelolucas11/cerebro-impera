import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { digest } from '../src/crypto/tokens.js';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import {
  attempt,
  attemptAlone,
  bind,
  buildScenario,
  connectAs,
  type Scenario,
} from './support/scenario.js';

/*
 * Limits the database keeps by itself, whatever a service is made to send it:
 * routines answer only outside a request; the login service cannot let anyone
 * in on a device nobody approved; request-wide counts live where no service
 * writes; people's rules hold under every service; a list's protection and
 * place change only with a fresh code, on the record; notifications follow
 * their item; the record takes only its own entries; and two people acting at
 * the same moment cannot leave the installation without an owner.
 */

interface Stage {
  id: string;
  kind: string;
}
interface FormView {
  id: string;
  address: string | null;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let other: pg.Client;
let login: pg.Client;
let forms: pg.Client;

const confirmCode = (person: Person): Promise<unknown> =>
  env.admin.query(`UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1`, [person.id]);
const deviceProof = (person: Person): Buffer => {
  const token = person.browser.cookies.get('__Host-cerebro_device');
  if (token === undefined) throw new Error('person has no device');
  return digest(token);
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  other = await connectAs(env, 'cerebro_app');
  login = await connectAs(env, 'cerebro_auth');
  forms = await connectAs(env, 'cerebro_forms');
});
// A failed check must not leave a transaction open for the next one.
afterEach(async () => {
  await Promise.all([app, other, login].map((client) => client.query('ROLLBACK')));
});
afterAll(async () => {
  await Promise.all([app.end(), other.end(), login.end(), forms.end()]);
  await env.close();
});

describe('the routines', () => {
  it('answer only outside anyone’s request', async () => {
    expect(await bind(app, s.owner)).toBe(true);
    for (const statement of [
      `SELECT app.record_scan(gen_random_uuid(), 'clean')`,
      'SELECT * FROM app.attachments_waiting_for_scan()',
      'SELECT * FROM app.take_disposals(10)',
      'SELECT app.purge_trash()',
      'SELECT app.purge_attachments()',
      'SELECT app.purge_automation_runs()',
      'SELECT app.notify_due()',
    ]) {
      expect(await attempt(app, statement), statement).toMatchObject({ ok: false, code: 'CB001' });
    }
    // Their bodies are no one's to call by another name.
    expect((await attempt(app, 'SELECT app.purge_trash_unguarded()')).code).toBe('42501');
    await app.query('ROLLBACK');
    expect((await attemptAlone(app, 'SELECT app.purge_trash() AS n')).ok).toBe(true);
  });
});

describe('the login service', () => {
  it('cannot approve a device, nor take over one', async () => {
    await login.query('BEGIN');
    for (const [statement, values] of [
      [
        `INSERT INTO auth.devices (user_id, token_hash, status) VALUES ($1, sha256('x'), 'approved')`,
        [s.ana.id],
      ],
      [
        `INSERT INTO auth.devices (user_id, token_hash, decided_by, decided_at)
         VALUES ($1, sha256('y'), $1, now())`,
        [s.ana.id],
      ],
      // As setup does for the first owner, but setup is long over.
      [
        `INSERT INTO auth.devices (user_id, token_hash, status, decided_by)
         VALUES ($1, sha256('w'), 'approved', $1)`,
        [s.owner.id],
      ],
      [`UPDATE auth.devices SET decided_at = now() WHERE user_id = $1`, [s.ana.id]],
      [`UPDATE auth.devices SET token_hash = sha256('z') WHERE user_id = $1`, [s.ana.id]],
      [`UPDATE auth.devices SET user_id = $1 WHERE user_id = $2`, [s.owner.id, s.ana.id]],
      [`UPDATE auth.devices SET last_seen_at = now() WHERE user_id = $1`, [s.ana.id]],
    ] as [string, unknown[]][]) {
      expect(await attempt(login, statement, values), statement).toMatchObject({
        ok: false,
        code: 'CB001',
      });
    }
    // Asking for approval is all it does.
    const asks = await attempt(
      login,
      `INSERT INTO auth.devices (user_id, token_hash) VALUES ($1, sha256('novo'))`,
      [s.ana.id],
    );
    expect(asks).toMatchObject({ ok: true, rowCount: 1 });
    const again = await attempt(
      login,
      `UPDATE auth.devices SET status = 'pending', decided_by = NULL, decided_at = NULL,
              created_at = now() WHERE user_id = $1 AND token_hash = sha256('novo')`,
      [s.ana.id],
    );
    expect(again).toMatchObject({ ok: true, rowCount: 1 });
    // Waiting, it is still the same device of the same person.
    for (const change of [
      `status = 'approved'`,
      `token_hash = sha256('trocado')`,
      `user_id = '${s.owner.id}'`,
      `last_seen_at = now()`,
    ]) {
      expect(
        await attempt(login, `UPDATE auth.devices SET ${change} WHERE token_hash = sha256('novo')`),
        change,
      ).toMatchObject({ ok: false, code: 'CB001' });
    }
    await login.query('ROLLBACK');
  });

  it('opens a session only on an approved device of the same person, shown its secret', async () => {
    await login.query('BEGIN');
    const open = (user: string, proof: Buffer) =>
      attempt(
        login,
        `SELECT auth.open_session(gen_random_uuid(), $1, $2, $3, NULL, 'teste') AS hours`,
        [user, proof, digest('sessão-nova')],
      );
    expect(
      await attempt(
        login,
        `INSERT INTO auth.sessions (user_id, device_id, token_hash, expires_at)
         SELECT user_id, id, sha256('s'), now() + interval '1 hour' FROM auth.devices LIMIT 1`,
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    expect(await open(s.ana.id, digest('chute'))).toMatchObject({ ok: false, code: 'CB001' });
    // Ana's own device, for someone else.
    expect(await open(s.owner.id, deviceProof(s.ana))).toMatchObject({ ok: false, code: 'CB001' });
    const hours = (
      await env.admin.query<{ h: number }>(
        'SELECT session_absolute_hours AS h FROM app.instance_settings',
      )
    ).rows[0]?.h;
    const opened = await open(s.ana.id, deviceProof(s.ana));
    expect(opened).toMatchObject({ ok: true, rows: [{ hours }] });
    const session = await login.query<{ fresh: boolean; long: boolean }>(
      `SELECT step_up_at = now() AS fresh,
              expires_at = now() + make_interval(hours => $2) AS long
       FROM auth.sessions WHERE token_hash = sha256($1)`,
      [digest('sessão-nova'), hours],
    );
    expect(session.rows).toEqual([{ fresh: true, long: true }]);

    // Once revoked, the device opens nothing.
    await env.admin.query(`UPDATE auth.devices SET status = 'revoked' WHERE user_id = $1`, [
      s.bruno.id,
    ]);
    expect(await open(s.bruno.id, deviceProof(s.bruno))).toMatchObject({
      ok: false,
      code: 'CB001',
    });
    await env.admin.query(`UPDATE auth.devices SET status = 'approved' WHERE user_id = $1`, [
      s.bruno.id,
    ]);
    // Nor for an account no longer active.
    await env.admin.query(`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.bruno.id]);
    expect(await open(s.bruno.id, deviceProof(s.bruno))).toMatchObject({
      ok: false,
      code: 'CB001',
    });
    await env.admin.query(`UPDATE app.users SET status = 'active' WHERE id = $1`, [s.bruno.id]);
    await login.query('ROLLBACK');
  });

  it('changes a session only to end it, for good, or to mark a code confirmed now', async () => {
    await login.query('BEGIN');
    const where = `WHERE user_id = '${s.nuno.id}' AND revoked_at IS NULL`;
    for (const change of [
      `expires_at = expires_at + interval '1 day'`,
      `token_hash = sha256('outra')`,
      `last_seen_at = now()`,
      `user_id = '${s.owner.id}'`,
      `revoked_reason = 'nada'`,
      `step_up_at = NULL`,
    ]) {
      expect(
        await attempt(login, `UPDATE auth.sessions SET ${change} ${where}`),
        change,
      ).toMatchObject({ ok: false, code: 'CB001' });
    }
    const later = await attempt(
      login,
      `UPDATE auth.sessions SET step_up_at = now() + interval '1 day' ${where}
       RETURNING step_up_at = now() AS now`,
    );
    expect(later).toMatchObject({ ok: true, rows: [{ now: true }] });
    const ended = await attempt(
      login,
      `UPDATE auth.sessions SET revoked_at = now() - interval '1 day', revoked_reason = 'teste'
       ${where} RETURNING revoked_at = now() AS now`,
    );
    expect(ended).toMatchObject({ ok: true, rows: [{ now: true }] });
    const gone = `WHERE user_id = '${s.nuno.id}'`;
    for (const change of [
      'revoked_at = NULL',
      `step_up_at = now() + interval '1 minute'`,
      `revoked_reason = 'outra'`,
    ]) {
      expect(
        await attempt(login, `UPDATE auth.sessions SET ${change} ${gone}`),
        change,
      ).toMatchObject({ ok: false, code: 'CB001' });
    }
    await login.query('ROLLBACK');
  });

  it('uses an invite up, once, and activates an account only by its own invite', async () => {
    const zeca = (
      await env.admin.query<{ id: string }>(
        `INSERT INTO app.users (email, name, role, status)
         VALUES ('zeca@exemplo.test', 'Zeca', 'employee', 'invited') RETURNING id`,
      )
    ).rows[0]?.id;
    await login.query('BEGIN');
    for (const [statement, code] of [
      [
        `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
         VALUES (sha256('convite'), '${zeca}', 'invite', '${s.owner.id}', now() + interval '1 day')`,
        '42501',
      ],
      ['DELETE FROM auth.invites', '42501'],
      [`UPDATE auth.invites SET expires_at = now() + interval '1 year'`, '42501'],
      ['UPDATE auth.invites SET used_at = NULL WHERE used_at IS NOT NULL', 'CB001'],
      [`UPDATE app.users SET status = 'active' WHERE id = '${zeca}'`, 'CB001'],
    ] as [string, string][]) {
      expect(await attempt(login, statement), statement).toMatchObject({ ok: false, code });
    }
    await login.query('ROLLBACK');

    await env.admin.query(
      `INSERT INTO auth.invites (token_hash, user_id, kind, created_by, expires_at)
       VALUES (sha256('convite'), $1, 'invite', $2, now() + interval '1 day')`,
      [zeca, s.owner.id],
    );
    await login.query('BEGIN');
    // Clearing it is not using it.
    expect(
      await attempt(login, 'UPDATE auth.invites SET used_at = NULL WHERE user_id = $1', [zeca]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    await login.query('ROLLBACK');
    await login.query('BEGIN');
    const used = await attempt(
      login,
      `UPDATE auth.invites SET used_at = now() - interval '1 day' WHERE user_id = $1
       RETURNING used_at = now() AS now`,
      [zeca],
    );
    expect(used).toMatchObject({ ok: true, rows: [{ now: true }] });
    const active = await attempt(login, `UPDATE app.users SET status = 'active' WHERE id = $1`, [
      zeca,
    ]);
    expect(active).toMatchObject({ ok: true, rowCount: 1 });
    await login.query('ROLLBACK');
    await env.admin.query('DELETE FROM app.users WHERE id = $1', [zeca]);
  });
});

describe('counts across a request', () => {
  it('cannot be reset by the application', async () => {
    // Marta edits every item of the list, with her code confirmed, but may not
    // send several to the trash at once.
    await confirmCode(s.marta);
    expect(await bind(app, s.marta)).toBe(true);
    await app.query(`SELECT set_config('cerebro.trashed_in_request', '-10', true)`);
    const first = await attempt(app, 'UPDATE app.items SET deleted_at = now() WHERE id = $1', [
      s.itemAna,
    ]);
    expect(first).toMatchObject({ ok: true, rowCount: 1 });
    const second = await attempt(app, 'UPDATE app.items SET deleted_at = now() WHERE id = $1', [
      s.itemNobody,
    ]);
    expect(second).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    // Each request counts from zero, on the same connection.
    for (const item of [s.itemAna, s.itemNobody]) {
      expect(await bind(app, s.marta)).toBe(true);
      expect(
        await attempt(app, 'UPDATE app.items SET deleted_at = now() WHERE id = $1', [item]),
      ).toMatchObject({ ok: true, rowCount: 1 });
      await app.query('COMMIT');
    }
    await env.admin.query('UPDATE app.items SET deleted_at = NULL WHERE id = ANY ($1::uuid[])', [
      [s.itemAna, s.itemNobody],
    ]);

    // Nor can it keep a change of a rule out of the item's history.
    expect(await bind(app, s.ana)).toBe(true);
    await app.query(`SELECT set_config('cerebro.repeating', 'on', true)`);
    await app.query(
      `INSERT INTO app.item_recurrences (item_id, unit, every) VALUES ($1, 'week', 1)`,
      [s.itemAna],
    );
    await app.query('COMMIT');
    const history = await env.admin.query(
      `SELECT count(*)::int AS n FROM app.item_changes WHERE item_id = $1 AND what = 'recurrence'`,
      [s.itemAna],
    );
    expect(history.rows).toEqual([{ n: 1 }]);
    await env.admin.query('DELETE FROM app.item_recurrences WHERE item_id = $1', [s.itemAna]);
  });
});

describe('people’s rules under the forms service', () => {
  let blocked: Stage;
  let slug: string;

  beforeAll(async () => {
    blocked = (
      await s.owner.browser.post<Stage>(`/api/lists/${s.tarefas}/stages`, {
        name: 'Só donos',
        kind: 'active',
      })
    ).body;
    await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
    });
    await confirmCode(s.owner);
    const made = await s.owner.browser.post<FormView>(`/api/lists/${s.tarefas}/forms`, {
      title: 'Contato',
      intro: '',
      titleLabel: 'Seu nome',
      descriptionLabel: null,
      fields: [],
      stageId: null,
      enabled: true,
    });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    slug = made.body.address?.split('/f/')[1] ?? '';
  });

  const submit = async (title: string): Promise<string> => {
    const result = await attemptAlone(
      forms,
      `SELECT app.form_submit($1, $2, NULL, '{}'::jsonb) AS outcome`,
      [slug, title],
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return String(result.rows[0]?.outcome);
  };
  const stageOfTitle = async (title: string): Promise<string | undefined> =>
    (
      await env.admin.query<{ stage_id: string }>(
        'SELECT stage_id FROM app.items WHERE list_id = $1 AND title = $2',
        [s.tarefas, title],
      )
    ).rows[0]?.stage_id;

  it('hold for the rules a form sets off', async () => {
    await s.owner.browser.patch(`/api/stages/${blocked.id}`, { entryRole: 'owner' });
    const rule = await s.marta.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/automations`, {
      name: 'Do formulário para o bloqueado',
      trigger: { on: 'created' },
      actions: [{ do: 'stage', to: blocked.id }],
    });
    expect(rule.status).toBe(200);
    expect(await submit('Pelo formulário')).toBe('sent');
    expect(await stageOfTitle('Pelo formulário')).not.toBe(blocked.id);
    const runs = (
      await s.marta.browser.get<{ outcome: string; detail: string }[]>(
        `/api/automations/${rule.body.id}/runs`,
      )
    ).body;
    expect(runs[0]).toMatchObject({ outcome: 'failed', detail: 'CB004' });
    await env.admin.query('DELETE FROM app.automations');
  });

  it('hand an item from a form only to someone who can still work on it', async () => {
    const rule = await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/automations`, {
      name: 'Do formulário para o Bruno',
      trigger: { on: 'created' },
      actions: [{ do: 'assign', to: s.bruno.id }],
    });
    expect(rule.status, JSON.stringify(rule.body)).toBe(200);
    const level = (to: string) =>
      env.admin.query(
        `UPDATE app.access_grants SET level = $3 WHERE user_id = $1 AND list_id = $2`,
        [s.bruno.id, s.tarefas, to],
      );
    await level('view');
    try {
      expect(await submit('Para quem não trabalha aqui')).toBe('sent');
      const assigned = await env.admin.query(
        `SELECT ia.user_id FROM app.item_assignees ia JOIN app.items i ON i.id = ia.item_id
         WHERE i.title = 'Para quem não trabalha aqui'`,
      );
      expect(assigned.rowCount).toBe(0);
      const runs = (
        await s.owner.browser.get<{ outcome: string; detail: string }[]>(
          `/api/automations/${rule.body.id}/runs`,
        )
      ).body;
      expect(runs[0]).toMatchObject({ outcome: 'failed', detail: 'CB003' });
    } finally {
      await level('edit');
      await env.admin.query('DELETE FROM app.automations');
    }
  });

  it('close a form whose author may no longer put items in its stage', async () => {
    await s.owner.browser.patch(`/api/stages/${blocked.id}`, { entryRole: null });
    await confirmCode(s.marta);
    const hers = await s.marta.browser.post<FormView>(`/api/lists/${s.tarefas}/forms`, {
      title: 'Da Marta',
      intro: '',
      titleLabel: 'Seu nome',
      descriptionLabel: null,
      fields: [],
      stageId: blocked.id,
      enabled: true,
    });
    expect(hers.status, JSON.stringify(hers.body)).toBe(200);
    slug = hers.body.address?.split('/f/')[1] ?? '';
    expect(await submit('Antes')).toBe('sent');
    expect(await stageOfTitle('Antes')).toBe(blocked.id);
    await s.owner.browser.patch(`/api/stages/${blocked.id}`, { entryRole: 'owner' });
    expect(await submit('Depois')).toBe('closed');
    expect(await stageOfTitle('Depois')).toBeUndefined();
  });
});

describe('a list’s protection and place', () => {
  it('change only by an owner with a fresh code, and go on the record', async () => {
    await expireStepUp(env, s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    expect(
      await attempt(app, 'UPDATE app.lists SET is_sensitive = false WHERE id = $1', [s.dinheiro]),
    ).toMatchObject({ ok: false, code: 'CB002' });
    expect(
      await attempt(app, 'UPDATE app.lists SET folder_id = NULL WHERE id = $1', [s.tarefas]),
    ).toMatchObject({ ok: false, code: 'CB002' });
    // Raising it needs nothing more than managing the list.
    expect(
      await attempt(app, 'UPDATE app.lists SET is_sensitive = true WHERE id = $1', [s.perfis]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('ROLLBACK');

    await confirmCode(s.marta);
    expect(await bind(app, s.marta)).toBe(true);
    expect(
      await attempt(app, 'UPDATE app.lists SET folder_id = NULL WHERE id = $1', [s.tarefas]),
    ).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    await confirmCode(s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    expect(
      await attempt(app, 'UPDATE app.lists SET is_sensitive = false WHERE id = $1', [s.dinheiro]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    expect(
      await attempt(app, `UPDATE app.lists SET name = 'Dinheiro e contas' WHERE id = $1`, [
        s.dinheiro,
      ]),
    ).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('COMMIT');
    const entries = await env.admin.query<{ action: string; actor: string; was: boolean }>(
      `SELECT action, actor_user_id AS actor, (metadata -> 'old' ->> 'is_sensitive')::boolean AS was
       FROM audit.log WHERE target_type = 'lists' AND target_id = $1`,
      [s.dinheiro],
    );
    expect(entries.rows).toEqual([{ action: 'lists.update', actor: s.owner.id, was: true }]);
    await env.admin.query(
      `UPDATE app.lists SET is_sensitive = true, name = 'Dinheiro' WHERE id = $1`,
      [s.dinheiro],
    );
  });
});

describe('notifications', () => {
  it('show only while their item can be seen', async () => {
    await env.admin.query(
      `INSERT INTO app.notifications (user_id, kind, item_id)
       VALUES ($1, 'assigned', $2), ($1, 'assigned', $3)`,
      [s.ana.id, s.itemMoney, s.itemAna],
    );
    expect(await bind(app, s.ana)).toBe(true);
    const seen = await app.query<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM app.notifications WHERE item_id = ANY ($1::uuid[])',
      [[s.itemMoney, s.itemAna]],
    );
    expect(seen.rows).toEqual([{ item_id: s.itemAna }]);
    const read = await app.query(
      `UPDATE app.notifications SET read_at = now() WHERE item_id = $1`,
      [s.itemMoney],
    );
    expect(read.rowCount).toBe(0);
    await app.query('ROLLBACK');
    await env.admin.query('DELETE FROM app.notifications');
  });
});

describe('the record', () => {
  it('takes from each service only its own entries, with who made them', async () => {
    expect(
      await attemptAlone(app, `SELECT audit.record('list.sensitive_viewed', 'list', 'x')`),
    ).toMatchObject({ ok: false, code: 'CB001' });
    expect(await bind(app, s.ana)).toBe(true);
    for (const [action, type, metadata] of [
      ['user.created', 'user', '{}'],
      ['items.purged', null, '{}'],
      ['list.sensitive_viewed', 'user', '{}'],
      ['list.sensitive_viewed', 'list', JSON.stringify({ filler: 'x'.repeat(9000) })],
    ]) {
      expect(
        await attempt(app, 'SELECT audit.record($1, $2, $3, $4::jsonb)', [
          action,
          type,
          s.tarefas,
          metadata,
        ]),
        String(action),
      ).toMatchObject({ ok: false, code: '22023' });
    }
    expect(
      await attempt(app, `SELECT audit.record('list.sensitive_viewed', 'list', $1)`, [s.tarefas]),
    ).toMatchObject({ ok: true });
    await app.query('ROLLBACK');

    await login.query('BEGIN');
    expect(
      await attempt(login, `SELECT audit.record_as(NULL, NULL, 'items.purged')`),
    ).toMatchObject({ ok: false, code: '22023' });
    expect(
      await attempt(login, `SELECT audit.record_as($1, NULL, 'login.failed', 'user', $2)`, [
        s.ana.id,
        s.ana.id,
      ]),
    ).toMatchObject({ ok: true });
    await login.query('ROLLBACK');
  });
});

describe('two at the same moment', () => {
  it('cannot leave the installation without an owner', async () => {
    await env.admin.query(`UPDATE app.users SET role = 'owner' WHERE id = $1`, [s.nuno.id]);
    await confirmCode(s.owner);
    await confirmCode(s.nuno);
    expect(await bind(app, s.owner)).toBe(true);
    expect(await bind(other, s.nuno)).toBe(true);
    await app.query(`UPDATE app.users SET role = 'admin' WHERE id = $1`, [s.nuno.id]);
    // Nuno demotes the owner while the owner demotes him: he waits, then counts again.
    const his = other.query(`UPDATE app.users SET role = 'admin' WHERE id = $1`, [s.owner.id]).then(
      () => 'ok',
      (error: unknown) => (error as { code?: string }).code,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    await app.query('COMMIT');
    expect(await his).toBe('CB003');
    await other.query('ROLLBACK');
    const owners = await env.admin.query(
      `SELECT id FROM app.users WHERE role = 'owner' AND status = 'active'`,
    );
    expect(owners.rows).toEqual([{ id: s.owner.id }]);
  });

  it('cannot set up two owners', async () => {
    const fresh = await createTestEnv();
    const [first, second] = await Promise.all([
      connectAs(fresh, 'cerebro_auth'),
      connectAs(fresh, 'cerebro_auth'),
    ]);
    try {
      const owner = (email: string) =>
        `INSERT INTO app.users (email, name, role, status)
         VALUES ('${email}', 'Dona', 'owner', 'active')`;
      await first.query('BEGIN');
      await second.query('BEGIN');
      await first.query(owner('uma@exemplo.test'));
      const late = second.query(owner('outra@exemplo.test')).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await first.query('COMMIT');
      expect(await late).toBe('CB001');
      await second.query('ROLLBACK');
    } finally {
      await Promise.all([first.end(), second.end()]);
      await fresh.close();
    }
  });
});
