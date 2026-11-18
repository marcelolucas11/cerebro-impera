import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The numbers of a list are counted as the person: each one counts only what
 * they see there, and reads only the names of people on those items. By the
 * API and at the database.
 */

interface Summary {
  total: number;
  finished: number;
  overdue: number;
  dueToday: number;
  byStage: { stageId: string; count: number; averageSeconds: number | null; stays: number }[];
  byAssignee: { userId: string | null; name: string | null; count: number }[];
  byField: { fieldId: string; options: { optionId: string | null; count: number }[] }[];
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stage: { open: string; active: string; done: string };
let supplier: { id: string; config: { options: { id: string }[] } };

const summaryOf = (person: Person, list: string = s.tarefas) =>
  person.browser.get<Summary & ErrorBody>(`/api/lists/${list}/summary`);
const day = async (offset: number): Promise<string> =>
  (await env.admin.query<{ d: string }>(`SELECT (current_date + $1::integer)::text AS d`, [offset]))
    .rows[0]?.d ?? '';

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const stages = (
    await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
  const of = (kind: string): string => stages.find((one) => one.kind === kind)?.id ?? '';
  stage = { open: of('open'), active: of('active'), done: of('done') };
  supplier = (
    await s.owner.browser.post<typeof supplier>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Fornecedor',
      kind: 'select',
      config: { options: [{ name: 'Alfa' }, { name: 'Beta' }] },
    })
  ).body;
  const [alfa, beta] = supplier.config.options.map((option) => option.id);
  const patch = (id: string, body: Record<string, unknown>) =>
    s.owner.browser.patch(`/api/items/${id}`, body);
  // Ana's: late, Alfa. Bruno's: due today, Beta, finished after a while in progress.
  // Nobody's: Alfa, no date.
  await patch(s.itemAna, { dueDate: await day(-2), fields: { [supplier.id]: alfa } });
  await patch(s.itemBruno, { dueDate: await day(0), fields: { [supplier.id]: beta } });
  await patch(s.itemNobody, { fields: { [supplier.id]: alfa } });
  await patch(s.itemBruno, { stageId: stage.active });
  await env.admin.query(
    `UPDATE app.item_stage_history SET entered_at = now() - interval '2 hours'
     WHERE item_id = $1 AND left_at IS NULL`,
    [s.itemBruno],
  );
  await patch(s.itemBruno, { stageId: stage.done });
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the numbers of a list', () => {
  it('count everything for whoever sees everything', async () => {
    const all = (await summaryOf(s.owner)).body;
    expect(all).toMatchObject({ total: 3, finished: 1, overdue: 1, dueToday: 0 });
    const count = (id: string) => all.byStage.find((one) => one.stageId === id)?.count;
    expect([count(stage.open), count(stage.active), count(stage.done)]).toEqual([2, 0, 1]);
    const active = all.byStage.find((one) => one.stageId === stage.active);
    expect(active?.stays).toBe(1);
    expect(active?.averageSeconds).toBeGreaterThanOrEqual(7190);
    expect(active?.averageSeconds).toBeLessThan(7300);
    expect(all.byAssignee).toEqual(
      expect.arrayContaining([
        { userId: s.ana.id, name: 'Ana Souza', count: 1 },
        { userId: s.bruno.id, name: 'Bruno Lima', count: 1 },
        { userId: null, name: null, count: 1 },
      ]),
    );
    const [alfa, beta] = supplier.config.options.map((option) => option.id);
    expect(all.byField).toEqual([
      {
        fieldId: supplier.id,
        options: expect.arrayContaining([
          { optionId: alfa, count: 2 },
          { optionId: beta, count: 1 },
        ]) as unknown,
      },
    ]);
  });

  it('count only her own items for someone who sees only hers, with no one else named', async () => {
    const hers = (await summaryOf(s.ana)).body;
    expect(hers).toMatchObject({ total: 1, finished: 0, overdue: 1, dueToday: 0 });
    expect(hers.byAssignee).toEqual([{ userId: s.ana.id, name: 'Ana Souza', count: 1 }]);
    expect(hers.byStage.reduce((sum, one) => sum + one.count, 0)).toBe(1);
    expect(hers.byStage.every((one) => one.stays === 0)).toBe(true);
    expect(hers.byField[0]?.options).toEqual([
      { optionId: supplier.config.options[0]?.id, count: 1 },
    ]);
  });

  it('are not there for whoever cannot open the list, and a sensitive one asks for the code', async () => {
    expect((await summaryOf(s.nuno)).status).toBe(404);
    await expireStepUp(env, s.owner);
    const locked = await summaryOf(s.owner, s.dinheiro);
    expect(locked.status).toBe(403);
    expect(locked.body.error.code).toBe('step_up_required');
  });
});

describe('at the database', () => {
  it('names only the people on items the person sees', async () => {
    const named = async (person: Person, list: string): Promise<string[]> => {
      expect(await bind(app, person)).toBe(true);
      const found = await app.query<{ name: string }>(
        'SELECT name FROM app.assignee_names($1) ORDER BY name',
        [list],
      );
      await app.query('COMMIT');
      return found.rows.map((row) => row.name);
    };
    expect(await named(s.marta, s.tarefas)).toEqual(['Ana Souza', 'Bruno Lima']);
    expect(await named(s.ana, s.tarefas)).toEqual(['Ana Souza']);
    expect(await named(s.nuno, s.tarefas)).toEqual([]);
    // What she created and handed on she still sees, with whom it is now.
    const handed = (
      await s.ana.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Criado pela Ana',
      })
    ).body.id;
    await s.owner.browser.put(`/api/items/${handed}/assignees`, { userIds: [s.bruno.id] });
    expect(await named(s.ana, s.tarefas)).toEqual(['Ana Souza', 'Bruno Lima']);
    await s.owner.browser.post(`/api/items/${handed}/trash`);
    // A grant that takes the list away names nobody, whatever else it says.
    await env.admin.query(
      `INSERT INTO app.access_grants (user_id, list_id, level, item_scope, granted_by)
       VALUES ($1, $2, 'none', 'all', $3)`,
      [s.marta.id, s.tarefas, s.owner.id],
    );
    expect(await named(s.marta, s.tarefas)).toEqual([]);
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2', [
      s.marta.id,
      s.tarefas,
    ]);
    // A sensitive list names nobody without a recent code.
    await env.admin.query(
      `INSERT INTO app.item_assignees (item_id, user_id, assigned_by) VALUES ($1, $2, $2)`,
      [s.itemMoney, s.owner.id],
    );
    expect(await named(s.owner, s.dinheiro)).toEqual([]);
    // Items in the trash are not counted, nor are their people named.
    await env.admin.query('ALTER TABLE app.items DISABLE TRIGGER trash_guard');
    await env.admin.query('UPDATE app.items SET deleted_at = now() WHERE id = $1', [s.itemBruno]);
    await env.admin.query('ALTER TABLE app.items ENABLE TRIGGER trash_guard');
    expect(await named(s.marta, s.tarefas)).toEqual(['Ana Souza']);
    expect((await summaryOf(s.marta)).body.total).toBe(2);
  });
});
