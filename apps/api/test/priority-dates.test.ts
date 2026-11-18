import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Priority, start and due date: set by whoever edits the item and nobody
 * else, a start never after the due date, every change in the history, and
 * nothing changes while the item is in the trash. By the API and at the
 * database.
 */

interface Item {
  id: string;
  priority: number | null;
  startDate: string | null;
  dueDate: string | null;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const patch = (person: Scenario['ana'], itemId: string, body: Record<string, unknown>) =>
  person.browser.patch<Item & ErrorBody>(`/api/items/${itemId}`, body);
const stored = async (itemId: string) =>
  (
    await env.admin.query<{ priority: number | null; start: string | null; due: string | null }>(
      `SELECT priority, start_date::text AS start, due_date::text AS due FROM app.items WHERE id = $1`,
      [itemId],
    )
  ).rows[0];
const newItem = async (title: string): Promise<string> =>
  (await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })).body.id;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('by the API', () => {
  it('sets, changes and clears priority and dates, each one alone', async () => {
    const set = await patch(s.ana, s.itemAna, {
      priority: 2,
      startDate: '2026-11-20',
      dueDate: '2026-11-25',
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ priority: 2, startDate: '2026-11-20', dueDate: '2026-11-25' });
    // Changing one leaves the others as they were.
    const moved = await patch(s.ana, s.itemAna, { dueDate: '2026-11-27' });
    expect(moved.body).toMatchObject({
      priority: 2,
      startDate: '2026-11-20',
      dueDate: '2026-11-27',
    });
    const cleared = await patch(s.ana, s.itemAna, { priority: null, startDate: null });
    expect(cleared.body).toMatchObject({ priority: null, startDate: null, dueDate: '2026-11-27' });
    // A title change does not touch them.
    expect((await patch(s.ana, s.itemAna, { title: 'Tarefa da Ana' })).body.dueDate).toBe(
      '2026-11-27',
    );
    const listed = (await s.ana.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
      (item) => item.id === s.itemAna,
    );
    expect(listed).toMatchObject({ priority: null, startDate: null, dueDate: '2026-11-27' });
  });

  it('refuses what is not a priority or not a day, and a start after the due date', async () => {
    for (const body of [
      { priority: 0 },
      { priority: 5 },
      { priority: 2.5 },
      { dueDate: '2026-02-30' },
      { dueDate: '20/11/2026' },
      { startDate: '2026-11-21', dueDate: '2026-11-20' },
    ]) {
      expect((await patch(s.ana, s.itemAna, body)).status, JSON.stringify(body)).toBe(400);
    }
    // Counting the date already there: a start after the kept due date is refused too.
    const late = await patch(s.ana, s.itemAna, { startDate: '2026-12-01' });
    expect(late.body.error.code).toBe('dates_out_of_order');
    const early = await patch(s.ana, s.itemAna, { startDate: '2026-11-01', dueDate: null });
    expect(early.body).toMatchObject({ startDate: '2026-11-01', dueDate: null });
  });

  it('only whoever edits the item sets them', async () => {
    // Ana edits only her own items; Bruno's does not exist for her.
    expect((await patch(s.ana, s.itemBruno, { priority: 1 })).status).toBe(404);
    expect((await stored(s.itemBruno))?.priority).toBeNull();
  });

  it('writes every change in the history, with who, before and after', async () => {
    const item = await newItem('Com prazo');
    await patch(s.marta, item, { priority: 3, dueDate: '2026-12-10' });
    await patch(s.marta, item, { priority: 1, startDate: '2026-12-01', dueDate: null });
    const lines = (
      await env.admin.query<{ what: string; actor: string; old: unknown; new: unknown }>(
        `SELECT what, actor, old, new FROM app.item_changes
         WHERE item_id = $1 AND what IN ('priority', 'start_date', 'due_date') ORDER BY id`,
        [item],
      )
    ).rows;
    expect(lines).toEqual([
      { what: 'priority', actor: s.marta.id, old: null, new: 3 },
      { what: 'due_date', actor: s.marta.id, old: null, new: '2026-12-10' },
      { what: 'priority', actor: s.marta.id, old: 3, new: 1 },
      { what: 'start_date', actor: s.marta.id, old: null, new: '2026-12-01' },
      { what: 'due_date', actor: s.marta.id, old: '2026-12-10', new: null },
    ]);
    // Saving the same values again adds nothing.
    await patch(s.marta, item, { priority: 1, startDate: '2026-12-01' });
    const again = await env.admin.query(
      `SELECT 1 FROM app.item_changes
       WHERE item_id = $1 AND what IN ('priority', 'start_date', 'due_date')`,
      [item],
    );
    expect(again.rowCount).toBe(5);
  });

  it('changes nothing while the item is in the trash', async () => {
    const item = await newItem('Na lixeira');
    expect((await s.marta.browser.post(`/api/items/${item}/trash`, {})).status).toBe(200);
    expect((await patch(s.marta, item, { priority: 1 })).status).toBe(404);
    expect((await stored(item))?.priority).toBeNull();
  });
});

describe('straight at the database', () => {
  it('only whoever edits the item sets them, and the rules hold for everyone', async () => {
    // A list Bruno can only read, with everything in it.
    const o = s.owner.browser;
    const showcase = (
      await o.post<{ id: string }>('/api/lists', { spaceId: s.financeiro, name: 'Mostruário' })
    ).body.id;
    const shown = (
      await o.post<{ id: string }>(`/api/lists/${showcase}/items`, { title: 'Só olhar' })
    ).body.id;
    expect(
      (
        await o.put('/api/grants', {
          userId: s.bruno.id,
          scopeType: 'list',
          scopeId: showcase,
          level: 'view',
          itemScope: 'all',
        })
      ).status,
    ).toBe(200);

    expect(await bind(app, s.bruno)).toBe(true);
    const reader = await attempt(app, `UPDATE app.items SET priority = 1 WHERE id = $1`, [shown]);
    expect(reader.ok && reader.rowCount === 1).toBe(false);
    const unseen = await attempt(
      app,
      `UPDATE app.items SET due_date = '2026-12-01' WHERE id = $1`,
      [s.itemAna],
    );
    expect(unseen.ok && unseen.rowCount === 1).toBe(false);
    // A statement that names no row is held to the same rule.
    const everything = await attempt(app, `UPDATE app.items SET priority = 1`);
    expect(everything.ok).toBe(true);
    await app.query('ROLLBACK');
    expect((await stored(shown))?.priority).toBeNull();
    expect((await stored(s.itemAna))?.due).not.toBe('2026-12-01');
    const ofAna = await stored(s.itemAna);
    expect(ofAna?.priority).toBeNull();

    expect(await bind(app, s.bruno)).toBe(true);
    for (const [text, code] of [
      [`UPDATE app.items SET priority = 5 WHERE id = $1`, '23514'],
      [
        `UPDATE app.items SET start_date = '2026-12-02', due_date = '2026-12-01' WHERE id = $1`,
        '23514',
      ],
    ] as const) {
      expect(await attempt(app, text, [s.itemBruno]), text).toMatchObject({ ok: false, code });
    }
    // The history is the database's to write.
    const forged = await attempt(
      app,
      `INSERT INTO app.item_changes (item_id, what, new) VALUES ($1, 'priority', '1')`,
      [s.itemBruno],
    );
    expect(forged.ok).toBe(false);
    await app.query('ROLLBACK');
  });

  it('records changes even when made straight at the database', async () => {
    expect(await bind(app, s.bruno)).toBe(true);
    const done = await attempt(app, `UPDATE app.items SET priority = 4 WHERE id = $1`, [
      s.itemBruno,
    ]);
    expect(done).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('COMMIT');
    const line = await env.admin.query(
      `SELECT actor, old, new FROM app.item_changes
       WHERE item_id = $1 AND what = 'priority' ORDER BY id DESC LIMIT 1`,
      [s.itemBruno],
    );
    expect(line.rows).toEqual([{ actor: s.bruno.id, old: null, new: 4 }]);
  });
});
