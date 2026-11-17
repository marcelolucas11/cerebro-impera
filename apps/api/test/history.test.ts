import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The history of an item: every change is on it, with who made it, whatever
 * path the change took; it is read by whoever reads the item and written by
 * nobody. First through the API, then straight at the database.
 */

interface Change {
  id: number;
  at: string;
  actor: string | null;
  what: string;
  fieldId: string | null;
  old: unknown;
  new: unknown;
}
interface Stage {
  id: string;
  name: string;
}
interface Field {
  id: string;
  config: { options?: { id: string; name: string }[] };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stages: Stage[];
let value: Field;
let supplier: Field;

/** Oldest first, which is how a story is told. */
const historyOf = async (person: Person, item: string): Promise<Change[]> => {
  const response = await person.browser.get<Change[]>(`/api/items/${item}/history?limit=200`);
  expect(response.status).toBe(200);
  return [...response.body].reverse();
};
const told = (changes: Change[]): unknown[][] =>
  changes.map((change) => [change.what, change.actor, change.old, change.new]);

const REFUSALS = new Set(['42501', 'CB001', 'CB002', 'CB003']);

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  stages = (await s.owner.browser.get<Stage[]>(`/api/lists/${s.tarefas}/stages`)).body;
  value = (
    await s.owner.browser.post<Field>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Valor',
      kind: 'money',
    })
  ).body;
  supplier = (
    await s.owner.browser.post<Field>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Fornecedor',
      kind: 'select',
      config: { options: [{ name: 'Alfa' }, { name: 'Beta' }] },
    })
  ).body;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the history of an item', () => {
  it('starts when the item is created, and says by whom', async () => {
    const before = await historyOf(s.owner, s.itemNobody);
    expect(told(before)).toEqual([['created', s.owner.id, null, { title: 'Tarefa sem dono' }]]);
    // An item handed to someone at birth: created, then assigned.
    expect((await historyOf(s.owner, s.itemAna)).map((change) => change.what)).toEqual([
      'created',
      'assigned',
    ]);
    // Created by someone who only sees their own items: it becomes theirs, and that is on record.
    const hers = await s.ana.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
      title: 'Criado pela Ana',
    });
    expect(told(await historyOf(s.ana, hers.body.id))).toEqual([
      ['created', s.ana.id, null, { title: 'Criado pela Ana' }],
      ['assigned', s.ana.id, null, s.ana.id],
    ]);
  });

  it('records every change, each with what it was and what it became', async () => {
    const [todo, doing] = stages;
    const alfa = supplier.config.options?.[0]?.id;
    const beta = supplier.config.options?.[1]?.id;
    const o = s.owner.browser;
    await o.patch(`/api/items/${s.itemNobody}`, { title: 'Tarefa com dono' });
    await o.patch(`/api/items/${s.itemNobody}`, { description: 'Primeira versão' });
    await o.patch(`/api/items/${s.itemNobody}`, { description: 'Segunda versão' });
    await o.patch(`/api/items/${s.itemNobody}`, { stageId: doing?.id });
    await o.put(`/api/items/${s.itemNobody}/assignees`, { userIds: [s.ana.id, s.bruno.id] });
    await o.put(`/api/items/${s.itemNobody}/assignees`, { userIds: [s.bruno.id] });
    await o.patch(`/api/items/${s.itemNobody}`, {
      fields: { [value.id]: 25_000, [supplier.id]: alfa },
    });
    await s.bruno.browser.patch(`/api/items/${s.itemNobody}`, {
      fields: { [value.id]: 30_000, [supplier.id]: beta },
    });
    await s.bruno.browser.patch(`/api/items/${s.itemNobody}`, { fields: { [value.id]: null } });

    const story = await historyOf(s.owner, s.itemNobody);
    expect(told(story)).toEqual([
      ['created', s.owner.id, null, { title: 'Tarefa sem dono' }],
      ['title', s.owner.id, 'Tarefa sem dono', 'Tarefa com dono'],
      ['description', s.owner.id, '', 'Primeira versão'],
      ['description', s.owner.id, 'Primeira versão', 'Segunda versão'],
      ['stage', s.owner.id, { id: todo?.id, name: 'A fazer' }, { id: doing?.id, name: 'Fazendo' }],
      ['assigned', s.owner.id, null, s.ana.id],
      ['assigned', s.owner.id, null, s.bruno.id],
      ['unassigned', s.owner.id, s.ana.id, null],
      ['field', s.owner.id, null, 25_000],
      ['field', s.owner.id, null, alfa],
      ['field', s.bruno.id, 25_000, 30_000],
      ['field', s.bruno.id, alfa, beta],
      ['field', s.bruno.id, 30_000, null],
    ]);
    const fields = story.filter((change) => change.what === 'field');
    expect(fields.map((change) => change.fieldId)).toEqual([
      value.id,
      supplier.id,
      value.id,
      supplier.id,
      value.id,
    ]);
    expect(story.filter((change) => change.what !== 'field').every((c) => c.fieldId === null)).toBe(
      true,
    );
    // In order, and each line with its moment.
    expect(story.map((change) => change.id)).toEqual(
      [...story.map((change) => change.id)].sort((a, b) => a - b),
    );
    expect(story.every((change) => !Number.isNaN(Date.parse(change.at)))).toBe(true);
  });

  it('adds nothing when a save changes nothing', async () => {
    const before = await historyOf(s.owner, s.itemNobody);
    await s.owner.browser.patch(`/api/items/${s.itemNobody}`, {
      title: 'Tarefa com dono',
      description: 'Segunda versão',
      stageId: stages[1]?.id,
      fields: { [supplier.id]: supplier.config.options?.[1]?.id, [value.id]: null },
    });
    await s.owner.browser.put(`/api/items/${s.itemNobody}/assignees`, { userIds: [s.bruno.id] });
    expect(await historyOf(s.owner, s.itemNobody)).toEqual(before);
  });

  it('is read in pages, newest first', async () => {
    const all = (await s.owner.browser.get<Change[]>(`/api/items/${s.itemNobody}/history`)).body;
    expect(all.length).toBe(13);
    const first = await s.owner.browser.get<Change[]>(`/api/items/${s.itemNobody}/history?limit=5`);
    expect(first.body.map((change) => change.id)).toEqual(all.slice(0, 5).map((c) => c.id));
    const next = await s.owner.browser.get<Change[]>(
      `/api/items/${s.itemNobody}/history?limit=5&before=${String(first.body.at(-1)?.id)}`,
    );
    expect(next.body.map((change) => change.id)).toEqual(all.slice(5, 10).map((c) => c.id));
    for (const query of ['limit=0', 'limit=1000', 'before=abc', 'other=1']) {
      const bad = await s.owner.browser.get(`/api/items/${s.itemNobody}/history?${query}`);
      expect(bad.status, query).toBe(400);
    }
  });

  it('is read by whoever can see the item, and by nobody else', async () => {
    // The item is now Bruno's: he reads its whole story, including what came before him.
    expect((await historyOf(s.bruno, s.itemNobody)).length).toBe(13);
    // Ana was taken off it: for her it no longer exists.
    expect((await s.ana.browser.get(`/api/items/${s.itemNobody}/history`)).status).toBe(404);
    expect((await s.ana.browser.get(`/api/items/${s.itemBruno}/history`)).status).toBe(404);
    expect((await s.nuno.browser.get(`/api/items/${s.itemAna}/history`)).status).toBe(404);
    expect((await s.ana.browser.get(`/api/items/${randomUUID()}/history`)).status).toBe(404);
    expect((await s.ana.browser.get(`/api/items/${s.itemMoney}/history`)).status).toBe(404);
  });

  it('keeps what a field once held out of reach while the field is archived', async () => {
    await s.owner.browser.patch(`/api/fields/${value.id}`, { archived: true });
    const hidden = await historyOf(s.bruno, s.itemNobody);
    expect(hidden.some((change) => change.fieldId === value.id)).toBe(false);
    expect(hidden.filter((change) => change.what === 'field')).toHaveLength(2);
    expect(JSON.stringify(hidden)).not.toContain('25000');

    await s.owner.browser.patch(`/api/fields/${value.id}`, { archived: false });
    expect(await historyOf(s.bruno, s.itemNobody)).toHaveLength(13);
  });
});

describe('straight at the database', () => {
  it('the history writes itself, whoever changes the item and however', async () => {
    const id = randomUUID();
    expect(await bind(app, s.owner)).toBe(true);
    // Plain SQL, no API involved.
    await app.query('INSERT INTO app.items (id, list_id, title) VALUES ($1, $2, $3)', [
      id,
      s.tarefas,
      'Direto no banco',
    ]);
    await app.query(`UPDATE app.items SET title = 'Renomeado', description = 'x' WHERE id = $1`, [
      id,
    ]);
    await app.query('INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)', [
      id,
      s.ana.id,
    ]);
    await app.query(
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '100')`,
      [id, value.id],
    );
    await app.query(
      `UPDATE app.item_field_values SET value = '200' WHERE item_id = $1 AND field_id = $2`,
      [id, value.id],
    );
    await app.query('DELETE FROM app.item_field_values WHERE item_id = $1', [id]);
    await app.query('DELETE FROM app.item_assignees WHERE item_id = $1', [id]);
    const read = async (): Promise<{ what: string; actor: string; old: unknown; new: unknown }[]> =>
      (
        await app.query<{ what: string; actor: string; old: unknown; new: unknown }>(
          'SELECT what, actor, old, new FROM app.item_changes WHERE item_id = $1 ORDER BY id',
          [id],
        )
      ).rows;
    const story = await read();
    expect(story.map((row) => row.what)).toEqual([
      'created',
      'title',
      'description',
      'assigned',
      'field',
      'field',
      'field',
      'unassigned',
    ]);
    expect(story.every((row) => row.actor === s.owner.id)).toBe(true);
    expect(story.filter((row) => row.what === 'field').map((row) => [row.old, row.new])).toEqual([
      [null, 100],
      [100, 200],
      [200, null],
    ]);

    // Moved to another list: that is on record too, with the stage it landed on.
    await app.query('UPDATE app.items SET list_id = $1 WHERE id = $2', [s.perfis, id]);
    const moved = await read();
    expect(moved.map((row) => row.what)).toEqual([
      'created',
      'title',
      'description',
      'assigned',
      // What the fields of the list it left once held is no longer read from here.
      'unassigned',
      'list',
      'stage',
    ]);
    expect(moved.find((row) => row.what === 'list')).toMatchObject({
      old: s.tarefas,
      new: s.perfis,
      actor: s.owner.id,
    });
    await app.query('ROLLBACK');
  });

  it('nobody writes it, corrects it or erases it: not an employee, not an owner', async () => {
    for (const person of [s.ana, s.owner]) {
      expect(await bind(app, person)).toBe(true);
      const statements: [string, unknown[]][] = [
        [
          `INSERT INTO app.item_changes (item_id, what, new) VALUES ($1, 'title', '"forjado"')`,
          [s.itemAna],
        ],
        [`UPDATE app.item_changes SET new = '"reescrito"'`, []],
        [`UPDATE app.item_changes SET actor = $1`, [s.bruno.id]],
        [`UPDATE app.item_changes SET at = '2000-01-01'`, []],
        [`DELETE FROM app.item_changes`, []],
        [`DELETE FROM app.item_changes WHERE item_id = $1`, [s.itemAna]],
        [`TRUNCATE app.item_changes`, []],
      ];
      for (const [text, values] of statements) {
        const result = await attempt(app, text, values);
        expect(result.ok, text).toBe(false);
        expect(REFUSALS.has(result.code ?? ''), text).toBe(true);
      }
      await app.query('ROLLBACK');
    }
  });

  it('not even the owner of the database rewrites or erases it while the item exists', async () => {
    const before = await env.admin.query('SELECT count(*)::int AS n FROM app.item_changes');
    const tries = [
      `UPDATE app.item_changes SET new = '"reescrito"'`,
      `DELETE FROM app.item_changes`,
      `TRUNCATE app.item_changes`,
    ];
    for (const text of tries) {
      await expect(env.admin.query(text)).rejects.toMatchObject({ code: 'CB001' });
    }
    const after = await env.admin.query('SELECT count(*)::int AS n FROM app.item_changes');
    expect(after.rows).toEqual(before.rows);
  });

  it('an employee reads the history of their own items and of no other', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const seen = await app.query<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM app.item_changes',
    );
    const hers = await app.query<{ id: string }>('SELECT id FROM app.items');
    expect(seen.rows.map((row) => row.item_id).sort()).toEqual(
      hers.rows.map((row) => row.id).sort(),
    );
    expect(seen.rows.map((row) => row.item_id)).toContain(s.itemAna);
    expect(seen.rows.map((row) => row.item_id)).not.toContain(s.itemBruno);
    expect(seen.rows.map((row) => row.item_id)).not.toContain(s.itemNobody);
    await app.query('ROLLBACK');
    expect(
      (await env.admin.query('SELECT 1 FROM app.item_changes WHERE item_id = $1', [s.itemBruno]))
        .rowCount,
    ).toBeGreaterThan(0);
  });

  it('past values of a field follow the field: archived, or left in another list, they are not read', async () => {
    const visible = async (): Promise<number> =>
      (
        await app.query('SELECT 1 FROM app.item_changes WHERE item_id = $1 AND field_id = $2', [
          s.itemNobody,
          value.id,
        ])
      ).rowCount ?? 0;
    expect(await bind(app, s.owner)).toBe(true);
    expect(await visible()).toBe(3);
    await app.query('UPDATE app.list_fields SET is_archived = true WHERE id = $1', [value.id]);
    expect(await visible()).toBe(0);
    await app.query('UPDATE app.list_fields SET is_archived = false WHERE id = $1', [value.id]);
    expect(await visible()).toBe(3);
    await app.query('UPDATE app.items SET list_id = $1 WHERE id = $2', [s.perfis, s.itemNobody]);
    expect(await visible()).toBe(0);
    // Everything else about the item is still told.
    expect(
      (
        await app.query(`SELECT 1 FROM app.item_changes WHERE item_id = $1 AND what = 'title'`, [
          s.itemNobody,
        ])
      ).rowCount,
    ).toBe(1);
    await app.query('ROLLBACK');
  });

  it('goes away only together with its item, when the item is removed for good', async () => {
    const created = await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
      title: 'Para remover',
      fields: { [value.id]: 100 },
    });
    await s.owner.browser.put(`/api/items/${created.body.id}/assignees`, { userIds: [s.ana.id] });
    const count = async (): Promise<number> =>
      (
        await env.admin.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM app.item_changes WHERE item_id = $1',
          [created.body.id],
        )
      ).rows[0]?.n ?? -1;
    expect(await count()).toBe(3);
    // The application cannot remove items at all; this is the database's owner doing it.
    await env.admin.query('DELETE FROM app.items WHERE id = $1', [created.body.id]);
    expect(await count()).toBe(0);
  });
});
