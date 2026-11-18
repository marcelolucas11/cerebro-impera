import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The order of cards in a board column: set by whoever may edit the items,
 * all or nothing, without touching "last changed" or the history.
 */

interface Item {
  id: string;
  title: string;
  stageId: string;
  position: number | null;
  updatedAt: string;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stages: { id: string; name: string }[];

const itemsOf = async (): Promise<Item[]> =>
  (await s.marta.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
const order = (person: Scenario['marta'], stageId: string, ids: string[]) =>
  person.browser.put<ErrorBody>(`/api/lists/${s.tarefas}/order`, { stageId, ids });

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  stages = (
    await s.owner.browser.get<{ id: string; name: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('ordering a column', () => {
  it('puts the items in the order given, leaving their last change and history alone', async () => {
    const first = stages[0]?.id ?? '';
    const before = await itemsOf();
    const column = before.filter((item) => item.stageId === first).map((item) => item.id);
    expect(column.length).toBeGreaterThanOrEqual(3);
    const reversed = [...column].reverse();
    const history = await env.admin.query(`SELECT count(*)::int AS n FROM app.item_changes`);
    expect((await order(s.marta, first, reversed)).status).toBe(200);
    const after = await itemsOf();
    const placed = after
      .filter((item) => item.stageId === first)
      .sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity))
      .map((item) => item.id);
    expect(placed).toEqual(reversed);
    for (const item of after) {
      expect(item.updatedAt).toBe(before.find((one) => one.id === item.id)?.updatedAt);
    }
    const historyAfter = await env.admin.query(`SELECT count(*)::int AS n FROM app.item_changes`);
    expect(historyAfter.rows[0]).toEqual(history.rows[0]);
  });

  it('sends an item that changes stage to the end of its new column', async () => {
    const [first, second] = [stages[0]?.id ?? '', stages[1]?.id ?? ''];
    const moved = await s.marta.browser.patch<Item>(`/api/items/${s.itemNobody}`, {
      stageId: second,
    });
    expect(moved.body.position).toBeNull();
    await s.marta.browser.patch(`/api/items/${s.itemNobody}`, { stageId: first });
  });

  it('is all or nothing: one item that is not the caller’s to move refuses the whole order', async () => {
    const first = stages[0]?.id ?? '';
    const before = await itemsOf();
    // Ana edits only her own items; Tarefa sem dono is not hers.
    expect((await order(s.ana, first, [s.itemAna])).status).toBe(200);
    const mixed = await order(s.ana, first, [s.itemNobody, s.itemAna]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.code).toBe('invalid_order');
    const after = await itemsOf();
    expect(after.find((item) => item.id === s.itemNobody)?.position).toBe(
      before.find((item) => item.id === s.itemNobody)?.position,
    );
    // An item of another stage, or someone who may only look, changes nothing either.
    const second = stages[1]?.id ?? '';
    expect((await order(s.marta, second, [s.itemAna])).status).toBe(400);
    await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
      itemScope: 'all',
    });
    expect((await order(s.nuno, first, [s.itemAna])).status).toBe(403);
  });
});

describe('straight at the database', () => {
  it('only who edits an item places it, and placing it is not a change to it', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const other = await attempt(app, `UPDATE app.items SET position = 1 WHERE id = $1`, [
      s.itemBruno,
    ]);
    expect(other.ok && other.rowCount > 0).toBe(false);
    const own = await attempt(
      app,
      `UPDATE app.items SET position = 7 WHERE id = $1 RETURNING updated_at, position`,
      [s.itemAna],
    );
    expect(own.rowCount).toBe(1);
    await app.query('ROLLBACK');
    expect(await bind(app, s.nuno)).toBe(true);
    const viewer = await attempt(app, `UPDATE app.items SET position = 1 WHERE id = $1`, [
      s.itemAna,
    ]);
    expect(viewer.ok && viewer.rowCount > 0).toBe(false);
    await app.query('ROLLBACK');
    const touched = await env.admin.query<{ same: boolean }>(
      `WITH before AS (SELECT updated_at FROM app.items WHERE id = $1)
       UPDATE app.items SET position = 99 WHERE id = $1
       RETURNING updated_at = (SELECT updated_at FROM before) AS same`,
      [s.itemAna],
    );
    expect(touched.rows[0]?.same).toBe(true);
    const retitled = await env.admin.query<{ same: boolean }>(
      `WITH before AS (SELECT updated_at FROM app.items WHERE id = $1)
       UPDATE app.items SET title = 'Tarefa da Ana!' WHERE id = $1
       RETURNING updated_at = (SELECT updated_at FROM before) AS same`,
      [s.itemAna],
    );
    expect(retitled.rows[0]?.same).toBe(false);
  });
});
