import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Saved views belong to the person who saved them, for lists they can still
 * open. Nobody else reads or changes them, by the API or at the database.
 */

interface View {
  id: string;
  listId: string;
  name: string;
  kind: string;
  query: string;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('saved views', () => {
  it('are saved, renamed and removed by their owner', async () => {
    const created = await s.ana.browser.post<View>(`/api/lists/${s.tarefas}/views`, {
      name: 'Minhas urgentes',
      kind: 'board',
      query: '?quem=me&ordem=title',
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Minhas urgentes', kind: 'board' });
    const renamed = await s.ana.browser.patch<View>(`/api/views/${created.body.id}`, {
      name: 'Minhas, por título',
      kind: 'list',
    });
    expect(renamed.body).toMatchObject({ name: 'Minhas, por título', kind: 'list' });
    const mine = await s.ana.browser.get<View[]>(`/api/lists/${s.tarefas}/views`);
    expect(mine.body.map((view) => view.name)).toEqual(['Minhas, por título']);
    expect((await s.ana.browser.delete(`/api/views/${created.body.id}`)).status).toBe(200);
    expect((await s.ana.browser.get<View[]>(`/api/lists/${s.tarefas}/views`)).body).toEqual([]);
  });

  it('are nobody else’s: not a colleague’s, not a manager’s, not an owner’s', async () => {
    const hers = await s.ana.browser.post<View>(`/api/lists/${s.tarefas}/views`, {
      name: 'Particular',
      kind: 'list',
      query: '',
    });
    for (const person of [s.bruno, s.marta, s.owner]) {
      const theirs = await person.browser.get<View[]>(`/api/lists/${s.tarefas}/views`);
      expect(theirs.body.map((view) => view.id)).not.toContain(hers.body.id);
      expect(
        (await person.browser.patch(`/api/views/${hers.body.id}`, { name: 'Minha agora' })).status,
      ).toBe(404);
      expect((await person.browser.delete(`/api/views/${hers.body.id}`)).status).toBe(404);
    }
  });

  it('exist only for lists one can open, and go quiet when access goes', async () => {
    const elsewhere = await s.ana.browser.post<ErrorBody>(`/api/lists/${s.dinheiro}/views`, {
      name: 'Bisbilhotar',
      kind: 'list',
      query: '',
    });
    expect(elsewhere.status).toBe(404);
    // Bruno saves one, then loses the list: the view is out of reach, not handed out.
    const his = await s.bruno.browser.post<View>(`/api/lists/${s.tarefas}/views`, {
      name: 'Do Bruno',
      kind: 'list',
      query: '',
    });
    const grants = await s.owner.browser.get<{ id: string; scopeId: string }[]>(
      `/api/users/${s.bruno.id}/grants`,
    );
    const grant = grants.body.find((one) => one.scopeId === s.tarefas);
    await s.owner.browser.delete(`/api/grants/${grant?.id ?? ''}`);
    expect((await s.bruno.browser.patch(`/api/views/${his.body.id}`, { name: 'x' })).status).toBe(
      404,
    );
    expect(await bind(app, s.bruno)).toBe(true);
    const read = await attempt(app, `SELECT id FROM app.saved_views WHERE id = $1`, [his.body.id]);
    expect(read.rowCount).toBe(0);
    await app.query('ROLLBACK');
  });

  it('take only what an address can hold, under a name used once', async () => {
    const make = (body: Record<string, unknown>) =>
      s.ana.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/views`, {
        name: 'Válida',
        kind: 'list',
        query: '',
        ...body,
      });
    for (const query of ['busca=x', '?a=<script>', '?a="b"', `?${'a'.repeat(2000)}`]) {
      expect((await make({ query })).status, query).toBe(400);
    }
    for (const name of ['', '   ', 'x'.repeat(61), 'linha\nquebrada']) {
      expect((await make({ name })).status, JSON.stringify(name)).toBe(400);
    }
    expect((await make({ kind: 'calendario' })).status).toBe(400);
    expect((await make({ name: 'No calendário', kind: 'calendar' })).status).toBe(200);
    expect((await make({ name: 'Na tabela', kind: 'table' })).status).toBe(200);
    expect((await make({ name: 'Repetida' })).status).toBe(200);
    const twice = await make({ name: 'REPETIDA' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('view_name_taken');
  });

  it('are at most thirty per list and person', async () => {
    for (let n = 0; n < 30; n += 1) {
      const made = await s.marta.browser.post(`/api/lists/${s.tarefas}/views`, {
        name: `Visão ${n}`,
        kind: 'list',
        query: '',
      });
      expect(made.status).toBe(200);
    }
    const extra = await s.marta.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/views`, {
      name: 'Uma a mais',
      kind: 'list',
      query: '',
    });
    expect(extra.body.error.code).toBe('too_many_views');
  });
});

describe('straight at the database', () => {
  it('nobody reads, writes as, moves or forges another person’s view', async () => {
    const hers = await s.ana.browser.post<View>(`/api/lists/${s.tarefas}/views`, {
      name: 'Só minha',
      kind: 'list',
      query: '?quem=me',
    });
    expect(await bind(app, s.marta)).toBe(true);
    const checks: [string, unknown[]][] = [
      [`SELECT id FROM app.saved_views WHERE id = $1`, [hers.body.id]],
      [`UPDATE app.saved_views SET name = 'tomada' WHERE id = $1`, [hers.body.id]],
      [`DELETE FROM app.saved_views WHERE id = $1`, [hers.body.id]],
    ];
    for (const [text, values] of checks) {
      const result = await attempt(app, text, values);
      expect(result.ok && result.rowCount > 0, text).toBe(false);
    }
    // Statements that do not name a row still reach only her own views.
    const own = await attempt(app, `SELECT count(*)::int AS n FROM app.saved_views`);
    const ownCount = Number(own.rows[0]?.n ?? 0);
    const everyKind = await attempt(app, `UPDATE app.saved_views SET kind = 'board'`);
    expect(everyKind.rowCount).toBe(ownCount);
    const everyOne = await attempt(app, `DELETE FROM app.saved_views`);
    expect(everyOne.rowCount).toBe(ownCount);
    const hidden = await attempt(
      app,
      `INSERT INTO app.saved_views (id, list_id, name, kind, query)
       VALUES (gen_random_uuid(), $1, 'onde não entro', 'list', '')`,
      [s.dinheiro],
    );
    expect(hidden.ok).toBe(false);
    const asHer = await attempt(
      app,
      `INSERT INTO app.saved_views (id, user_id, list_id, name, kind, query)
       VALUES (gen_random_uuid(), $1, $2, 'em nome dela', 'list', '')`,
      [s.ana.id, s.tarefas],
    );
    expect(asHer.ok).toBe(false);
    await app.query('ROLLBACK');

    expect(await bind(app, s.ana)).toBe(true);
    const moved = await attempt(app, `UPDATE app.saved_views SET list_id = $1 WHERE id = $2`, [
      s.perfis,
      hers.body.id,
    ]);
    expect(moved).toMatchObject({ ok: false, code: '42501' });
    const handed = await attempt(app, `UPDATE app.saved_views SET user_id = $1 WHERE id = $2`, [
      s.marta.id,
      hers.body.id,
    ]);
    expect(handed).toMatchObject({ ok: false, code: '42501' });
    const strange = await attempt(
      app,
      `UPDATE app.saved_views SET query = 'javascript:alert(1)' WHERE id = $1`,
      [hers.body.id],
    );
    expect(strange).toMatchObject({ ok: false, code: '23514' });
    await app.query('ROLLBACK');
  });
});
