import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  codeFor,
  createTestEnv,
  expireStepUp,
  STRONG_PASSWORD,
  type Person,
  type TestEnv,
} from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * One's own account (password and sessions) and handing work to others: who
 * can be made responsible for an item, and who may see that list of people.
 */

interface ErrorBody {
  error: { code: string; details?: { problems?: string[] } };
}
interface Session {
  id: string;
  current: boolean;
}
interface Person_ {
  id: string;
  name: string;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const NEW_PASSWORD = 'farol-baixo-48-cadeira-nova'; // gitleaks:allow (senha fictícia de teste)

/** The same person on a second browser of the same, already approved, device. */
async function secondSession(person: Person): Promise<Browser> {
  const browser = new Browser(env.app);
  const device = person.browser.cookies.get('__Host-cerebro_device');
  if (device === undefined) throw new Error('no device cookie');
  browser.cookies.set('__Host-cerebro_device', device);
  await browser.post('/api/auth/login', { email: person.email, password: person.password });
  const verified = await browser.post<{ status: string }>('/api/auth/login/verify', {
    code: codeFor(env, person),
  });
  env.clock.advance();
  expect(verified.body.status).toBe('authenticated');
  return browser;
}

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('changing one’s own password', () => {
  it('takes the current password and a fresh code, and ends every other session', async () => {
    const other = await secondSession(s.bruno);
    expect((await other.get('/api/me')).status).toBe(200);
    const sessions = await s.bruno.browser.get<Session[]>('/api/me/sessions');
    expect(sessions.body.filter((session) => !session.current)).toHaveLength(1);

    const changed = await s.bruno.browser.post<{ endedSessions: number }>('/api/me/password', {
      currentPassword: s.bruno.password,
      newPassword: NEW_PASSWORD,
      code: codeFor(env, s.bruno),
    });
    env.clock.advance();
    expect(changed.status).toBe(200);
    expect(changed.body.endedSessions).toBe(1);

    // This session goes on; the other one is out at once.
    expect((await s.bruno.browser.get('/api/me')).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    // The old password no longer opens the door; the new one does.
    const fresh = new Browser(env.app);
    const old = await fresh.post('/api/auth/login', {
      email: s.bruno.email,
      password: s.bruno.password,
    });
    expect(old.status).toBe(401);
    const now = await fresh.post('/api/auth/login', {
      email: s.bruno.email,
      password: NEW_PASSWORD,
    });
    expect(now.status).toBe(200);
    s.bruno.password = NEW_PASSWORD;

    const trail = await env.admin.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit.log WHERE action = 'password.changed' AND actor_user_id = $1`,
      [s.bruno.id],
    );
    expect(trail.rows).toEqual([{ metadata: { endedSessions: 1 } }]);
  });

  it('refuses a wrong password or code the same way, and counts it', async () => {
    const WRONG = 'errada-de-proposito-1234'; // gitleaks:allow (senha fictícia de teste)
    const tries = [
      { currentPassword: WRONG, code: codeFor(env, s.ana) },
      { currentPassword: s.ana.password, code: '000000' },
    ];
    for (const attemptBody of tries) {
      const response = await s.ana.browser.post<ErrorBody>('/api/me/password', {
        ...attemptBody,
        newPassword: NEW_PASSWORD,
      });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('invalid_credentials');
    }
    // Failing does not sign her out: she simply tries again.
    expect((await s.ana.browser.get('/api/me')).status).toBe(200);
    const counted = await env.admin.query(
      `SELECT 1 FROM audit.log WHERE action = 'login.failed' AND actor_user_id = $1
         AND metadata ->> 'reason' = 'password_change'`,
      [s.ana.id],
    );
    expect(counted.rowCount).toBe(2);
  });

  it('holds the new password to the same rules as any other', async () => {
    const weak = await s.ana.browser.post<ErrorBody>('/api/me/password', {
      currentPassword: s.ana.password,
      newPassword: '12345678',
      code: codeFor(env, s.ana),
    });
    env.clock.advance();
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('weak_password');
    const same = await s.ana.browser.post<ErrorBody>('/api/me/password', {
      currentPassword: s.ana.password,
      newPassword: s.ana.password,
      code: codeFor(env, s.ana),
    });
    env.clock.advance();
    expect(same.body.error.code).toBe('same_password');
    for (const body of [
      {},
      { currentPassword: s.ana.password, newPassword: NEW_PASSWORD },
      { currentPassword: s.ana.password, newPassword: NEW_PASSWORD, code: '12' },
      { currentPassword: s.ana.password, newPassword: NEW_PASSWORD, code: '123456', extra: 1 },
    ]) {
      expect((await s.ana.browser.post('/api/me/password', body)).status).toBe(400);
    }
    expect(STRONG_PASSWORD).not.toBe(NEW_PASSWORD);
  });

  it('is only for whoever is signed in', async () => {
    const stranger = new Browser(env.app);
    const response = await stranger.post('/api/me/password', {
      currentPassword: s.ana.password,
      newPassword: NEW_PASSWORD,
      code: codeFor(env, s.ana),
    });
    expect(response.status).toBe(401);
  });
});

describe('one’s own sessions', () => {
  it('can be listed and ended, but only one’s own', async () => {
    const other = await secondSession(s.ana);
    const mine = (await s.ana.browser.get<Session[]>('/api/me/sessions')).body;
    const otherSession = mine.find((session) => !session.current);
    expect(otherSession).toBeDefined();
    // Bruno cannot end Ana's session, nor see it.
    const brunos = (await s.bruno.browser.get<Session[]>('/api/me/sessions')).body;
    expect(brunos.map((session) => session.id)).not.toContain(otherSession?.id);
    expect((await s.bruno.browser.delete(`/api/me/sessions/${otherSession?.id}`)).status).toBe(404);
    expect((await other.get('/api/me')).status).toBe(200);

    expect((await s.ana.browser.delete(`/api/me/sessions/${otherSession?.id}`)).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await s.ana.browser.get('/api/me')).status).toBe(200);
  });
});

describe('handing work to someone', () => {
  it('offers, to whoever hands out work in a list, the people who can work in it', async () => {
    const people = await s.owner.browser.get<Person_[]>(`/api/lists/${s.tarefas}/people`);
    expect(people.status).toBe(200);
    const names = people.body.map((person) => person.name);
    // Owner, the manager of the space, and the two who edit the list; not Nuno.
    expect(people.body.map((person) => person.id).sort()).toEqual(
      [s.owner.id, s.marta.id, s.ana.id, s.bruno.id].sort(),
    );
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    // Marta hands out work there without managing users.
    const byMarta = await s.marta.browser.get<Person_[]>(`/api/lists/${s.tarefas}/people`);
    expect(byMarta.body).toHaveLength(4);
  });

  it('is not shown to someone who only works on their own items, nor to outsiders', async () => {
    expect((await s.ana.browser.get(`/api/lists/${s.tarefas}/people`)).status).toBe(403);
    expect((await s.nuno.browser.get(`/api/lists/${s.tarefas}/people`)).status).toBe(404);
    await expireStepUp(env, s.owner);
    const sensitive = await s.owner.browser.get<ErrorBody>(`/api/lists/${s.dinheiro}/people`);
    expect(sensitive.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
  });

  it('only to someone who can work in the list', async () => {
    const refused = await s.marta.browser.put<ErrorBody>(`/api/items/${s.itemNobody}/assignees`, {
      userIds: [s.nuno.id],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('cannot_assign_person');
    const fine = await s.marta.browser.put(`/api/items/${s.itemNobody}/assignees`, {
      userIds: [s.ana.id, s.bruno.id],
    });
    expect(fine.status).toBe(200);
  });

  it('the database refuses it too, by any path', async () => {
    expect(await bind(app, s.marta)).toBe(true);
    const nuno = await attempt(
      app,
      'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)',
      [s.itemBruno, s.nuno.id],
    );
    expect(nuno).toMatchObject({ ok: false, code: 'CB003' });
    // Someone who could work here once, but is suspended now, is not handed anything new.
    await app.query('ROLLBACK');
    await env.admin.query(`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.bruno.id]);
    try {
      expect(await bind(app, s.marta)).toBe(true);
      const suspended = await attempt(
        app,
        'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)',
        [s.itemAna, s.bruno.id],
      );
      expect(suspended).toMatchObject({ ok: false, code: 'CB003' });
      const list = await app.query<{ id: string }>('SELECT id FROM app.list_people($1)', [
        s.tarefas,
      ]);
      expect(list.rows.map((row) => row.id)).not.toContain(s.bruno.id);
      await app.query('ROLLBACK');
    } finally {
      await env.admin.query(`UPDATE app.users SET status = 'active' WHERE id = $1`, [s.bruno.id]);
    }
    // Someone who may only look at the list cannot be handed its work either.
    const granted = await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
      itemScope: 'all',
    });
    expect(granted.status).toBe(200);
    expect(await bind(app, s.marta)).toBe(true);
    const viewer = await attempt(
      app,
      'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)',
      [s.itemBruno, s.nuno.id],
    );
    expect(viewer).toMatchObject({ ok: false, code: 'CB003' });
    const offered = await app.query<{ id: string }>('SELECT id FROM app.list_people($1)', [
      s.tarefas,
    ]);
    expect(offered.rows.map((row) => row.id)).not.toContain(s.nuno.id);
    await app.query('ROLLBACK');

    // And the people of a list are nobody's business but whoever hands out work in it.
    expect(await bind(app, s.ana)).toBe(true);
    const asAna = await app.query('SELECT * FROM app.list_people($1)', [s.tarefas]);
    expect(asAna.rowCount).toBe(0);
    const levelOf = await attempt(app, 'SELECT authz.list_level_of($1, $2)', [s.ana.id, s.tarefas]);
    expect(levelOf).toMatchObject({ ok: false, code: '42501' });
    await app.query('ROLLBACK');
  });
});
