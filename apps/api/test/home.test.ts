import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The start page: the unfinished items with the person, by when they are
 * due; notifications waiting; and the lists they pinned. Read with their own
 * access, so what they lose stops showing. By the API and at the database.
 */

interface Home {
  items: { id: string; title: string; listName: string; due: string }[];
  unread: number;
  pins: string[];
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let done: string;

const homeOf = async (person: Person): Promise<Home> =>
  (await person.browser.get<Home>('/api/home')).body;
const pin = (person: Person, listIds: string[]) =>
  person.browser.put<Home & ErrorBody>('/api/home/pins', { listIds });
const day = async (offset: number): Promise<string> =>
  (await env.admin.query<{ d: string }>(`SELECT (current_date + $1::integer)::text AS d`, [offset]))
    .rows[0]?.d ?? '';

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  done =
    (
      await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
    ).body.find((stage) => stage.kind === 'done')?.id ?? '';
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the items on a start page', () => {
  it('are the unfinished ones with the person, grouped by when they are due', async () => {
    const make = async (title: string, dueIn: number | null): Promise<string> => {
      const id = (
        await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })
      ).body.id;
      await s.owner.browser.put(`/api/items/${id}/assignees`, { userIds: [s.ana.id] });
      if (dueIn !== null) {
        await s.owner.browser.patch(`/api/items/${id}`, { dueDate: await day(dueIn) });
      }
      return id;
    };
    await s.owner.browser.patch(`/api/items/${s.itemAna}`, { dueDate: await day(-1) });
    await make('Para hoje', 0);
    await make('Para a semana', 5);
    await make('Para depois', 20);
    await make('Sem prazo', null);
    const finished = await make('Já feito', 0);
    await s.owner.browser.patch(`/api/items/${finished}`, { stageId: done });
    const trashed = await make('Jogado fora', 0);
    await s.owner.browser.post(`/api/items/${trashed}/trash`);

    const hers = await homeOf(s.ana);
    expect(hers.items.map((item) => [item.title, item.due])).toEqual([
      ['Tarefa da Ana', 'overdue'],
      ['Para hoje', 'today'],
      ['Para a semana', 'week'],
      ['Para depois', 'later'],
      ['Sem prazo', 'later'],
    ]);
    expect(hers.items[0]?.listName).toBe('Tarefas');
    // Bruno's are not hers; and the owner, with nothing assigned, has none.
    expect((await homeOf(s.bruno)).items.map((item) => item.title)).toEqual(['Tarefa do Bruno']);
    expect((await homeOf(s.owner)).items).toEqual([]);
  });

  it('show a sensitive list only after the code', async () => {
    await s.owner.browser.put(`/api/items/${s.itemMoney}/assignees`, { userIds: [s.owner.id] });
    expect((await homeOf(s.owner)).items.map((item) => item.title)).toEqual(['Conta principal']);
    await expireStepUp(env, s.owner);
    expect((await homeOf(s.owner)).items).toEqual([]);
  });

  it('count the notifications waiting', async () => {
    const before = (await homeOf(s.bruno)).unread;
    await s.owner.browser.post(`/api/items/${s.itemBruno}/comments`, { body: 'Bruno, veja.' });
    expect((await homeOf(s.bruno)).unread).toBe(before + 1);
  });
});

describe('pinned lists', () => {
  it('are the person’s own, in their order, and only lists they can open', async () => {
    expect((await pin(s.marta, [s.perfis, s.tarefas])).body.pins).toEqual([s.perfis, s.tarefas]);
    expect((await pin(s.marta, [s.tarefas, s.perfis])).body.pins).toEqual([s.tarefas, s.perfis]);
    expect((await homeOf(s.ana)).pins).toEqual([]);
    expect((await pin(s.ana, [s.perfis])).status).toBe(404);
    expect((await pin(s.ana, [s.tarefas, s.tarefas])).status).toBe(400);
    expect(
      (
        await pin(
          s.ana,
          Array.from({ length: 13 }, () => s.tarefas),
        )
      ).status,
    ).toBe(400);
    expect((await pin(s.ana, [s.tarefas])).body.pins).toEqual([s.tarefas]);

    // A list she loses stops showing; it comes back with the access.
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1', [s.ana.id]);
    expect((await homeOf(s.ana)).pins).toEqual([]);
    await env.admin.query(
      `INSERT INTO app.access_grants (user_id, list_id, level, item_scope, granted_by)
       VALUES ($1, $2, 'edit', 'assigned', $3)`,
      [s.ana.id, s.tarefas, s.owner.id],
    );
    expect((await homeOf(s.ana)).pins).toEqual([s.tarefas]);
    expect((await pin(s.ana, [])).body.pins).toEqual([]);
  });

  it('cannot be read, written or reordered for someone else at the database', async () => {
    await pin(s.marta, [s.tarefas]);
    expect(await bind(app, s.ana)).toBe(true);
    expect((await attempt(app, 'SELECT * FROM app.home_pins')).rowCount).toBe(0);
    expect(
      await attempt(
        app,
        'INSERT INTO app.home_pins (user_id, list_id, position) VALUES ($1, $2, 0)',
        [s.marta.id, s.tarefas],
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    expect(
      await attempt(app, 'INSERT INTO app.home_pins (list_id, position) VALUES ($1, 0)', [
        s.perfis,
      ]),
    ).toMatchObject({ ok: false, code: '42501' });
    expect(
      await attempt(app, 'UPDATE app.home_pins SET position = 5 WHERE list_id = $1', [s.tarefas]),
    ).toMatchObject({ ok: false, code: '42501' });
    await app.query('DELETE FROM app.home_pins');
    await app.query('COMMIT');
    expect((await homeOf(s.marta)).pins).toEqual([s.tarefas]);
    // Positions are 0 to 11, one list per position.
    const bad = await env.admin
      .query(`INSERT INTO app.home_pins (user_id, list_id, position) VALUES ($1, $2, 12)`, [
        s.marta.id,
        s.perfis,
      ])
      .then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(bad).toBe('23514');
    const twice = await env.admin
      .query(`INSERT INTO app.home_pins (user_id, list_id, position) VALUES ($1, $2, 0)`, [
        s.marta.id,
        s.perfis,
      ])
      .then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(twice).toBe('23505');
  });
});
