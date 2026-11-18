import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The trash: who may send an item there and bring it back, what an item in the
 * trash can and cannot be, and the thirty days after which it is removed for
 * good. First through the API, then straight at the database.
 */

interface ErrorBody {
  error: { code: string };
}
interface Item {
  id: string;
  title: string;
  stageId: string;
  assignees: string[];
  fields: Record<string, unknown>;
  trashedAt: string | null;
  trashedBy: string | null;
}
interface Stage {
  id: string;
  name: string;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let notes: string;
let stages: Stage[];

const ids = async (person: Person, path: string): Promise<string[]> =>
  (await person.browser.get<Item[]>(path)).body.map((item) => item.id);
const live = (person: Person, list: string): Promise<string[]> =>
  ids(person, `/api/lists/${list}/items`);
const trashed = (person: Person, list: string): Promise<string[]> =>
  ids(person, `/api/lists/${list}/trash`);
const newItem = async (person: Person, title: string): Promise<string> => {
  const created = await person.browser.post<Item>(`/api/lists/${s.tarefas}/items`, { title });
  expect(created.status).toBe(200);
  return created.body.id;
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  notes = (
    await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Notas',
      kind: 'text',
    })
  ).body.id;
  stages = (await s.owner.browser.get<Stage[]>(`/api/lists/${s.tarefas}/stages`)).body;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('sending an item to the trash', () => {
  it('takes it out of the list for everyone, and into the trash of whoever could see it', async () => {
    await s.ana.browser.patch(`/api/items/${s.itemAna}`, {
      stageId: stages[1]?.id,
      fields: { [notes]: 'Anotação da Ana' },
    });
    const sent = await s.ana.browser.post(`/api/items/${s.itemAna}/trash`);
    expect(sent.status).toBe(200);

    expect(await live(s.ana, s.tarefas)).not.toContain(s.itemAna);
    expect(await live(s.owner, s.tarefas)).not.toContain(s.itemAna);
    expect(await trashed(s.ana, s.tarefas)).toEqual([s.itemAna]);
    expect(await trashed(s.owner, s.tarefas)).toEqual([s.itemAna]);
    expect(await trashed(s.marta, s.tarefas)).toEqual([s.itemAna]);
    // Bruno never saw it, and does not see it in the trash either.
    expect(await trashed(s.bruno, s.tarefas)).toEqual([]);
    expect((await s.nuno.browser.get(`/api/lists/${s.tarefas}/trash`)).status).toBe(404);

    const [entry] = (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/trash`)).body;
    expect(entry?.trashedBy).toBe(s.ana.id);
    expect(Date.now() - Date.parse(entry?.trashedAt ?? '')).toBeLessThan(60_000);
  });

  it('leaves nothing to do with the item outside the trash', async () => {
    const b = s.owner.browser;
    const tries = [
      b.patch(`/api/items/${s.itemAna}`, { title: 'Mexido' }),
      b.patch(`/api/items/${s.itemAna}`, { fields: { [notes]: 'Mexido' } }),
      b.put(`/api/items/${s.itemAna}/assignees`, { userIds: [s.bruno.id] }),
      b.get(`/api/items/${s.itemAna}/history`),
      b.get(`/api/items/${s.itemAna}/stage-history`),
      b.post(`/api/items/${s.itemAna}/trash`),
    ];
    for (const response of await Promise.all(tries)) expect(response.status).toBe(404);
  });

  it('is for whoever may edit the item, and for nobody else', async () => {
    // Ana cannot reach Bruno's item; Nuno reaches nothing in this list.
    expect((await s.ana.browser.post(`/api/items/${s.itemBruno}/trash`)).status).toBe(404);
    expect((await s.nuno.browser.post(`/api/items/${s.itemBruno}/trash`)).status).toBe(404);
    expect((await s.ana.browser.post(`/api/items/${randomUUID()}/trash`)).status).toBe(404);
    // Someone who may only look at a list cannot throw anything of it away.
    const showcase = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.financeiro,
        name: 'Vitrine',
      })
    ).body.id;
    const shown = (
      await s.owner.browser.post<Item>(`/api/lists/${showcase}/items`, { title: 'Só para ver' })
    ).body.id;
    await s.owner.browser.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: showcase,
      level: 'view',
      itemScope: 'all',
    });
    expect((await s.bruno.browser.post(`/api/items/${shown}/trash`)).status).toBe(403);
    expect(await live(s.bruno, showcase)).toEqual([shown]);
    expect(await live(s.bruno, s.tarefas)).toEqual([s.itemBruno]);
  });

  it('of a sensitive list needs a recent second factor, like reading it', async () => {
    await expireStepUp(env, s.owner);
    const closed = await s.owner.browser.get<ErrorBody>(`/api/lists/${s.dinheiro}/trash`);
    expect(closed.body.error.code).toBe('step_up_required');
    // Without it, the items of that list are out of reach altogether.
    expect((await s.owner.browser.post(`/api/items/${s.itemMoney}/trash`)).status).toBe(404);
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect(await trashed(s.owner, s.dinheiro)).toEqual([]);
  });
});

describe('bringing an item back', () => {
  it('returns it exactly as it was, and the history tells both moves', async () => {
    const back = await s.ana.browser.post<Item>(`/api/items/${s.itemAna}/restore`);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      id: s.itemAna,
      stageId: stages[1]?.id,
      assignees: [s.ana.id],
      fields: { [notes]: 'Anotação da Ana' },
      trashedAt: null,
      trashedBy: null,
    });
    expect(await live(s.ana, s.tarefas)).toContain(s.itemAna);
    expect(await trashed(s.owner, s.tarefas)).toEqual([]);

    const story = (
      await s.owner.browser.get<{ what: string; actor: string }[]>(
        `/api/items/${s.itemAna}/history`,
      )
    ).body;
    expect(story.slice(0, 2).map((change) => [change.what, change.actor])).toEqual([
      ['restored', s.ana.id],
      ['trashed', s.ana.id],
    ]);
  });

  it('is refused for an item that is not in the trash, and for anyone who could not see it', async () => {
    const notThere = await s.ana.browser.post<ErrorBody>(`/api/items/${s.itemAna}/restore`);
    expect(notThere.status).toBe(409);
    expect(notThere.body.error.code).toBe('not_in_trash');
    // Bruno's item, thrown away by the owner: not Ana's to bring back, and not even there for her.
    await s.owner.browser.post(`/api/items/${s.itemBruno}/trash`);
    expect((await s.ana.browser.post(`/api/items/${s.itemBruno}/restore`)).status).toBe(404);
    expect((await s.nuno.browser.post(`/api/items/${s.itemBruno}/restore`)).status).toBe(404);
    expect(await trashed(s.bruno, s.tarefas)).toEqual([s.itemBruno]);
    expect((await s.bruno.browser.post(`/api/items/${s.itemBruno}/restore`)).status).toBe(200);
  });
});

describe('removing a stage', () => {
  it('takes the items in the trash along to the stage that replaces it', async () => {
    const extra = (
      await s.owner.browser.post<Stage>(`/api/lists/${s.tarefas}/stages`, { name: 'Temporária' })
    ).body;
    const item = await newItem(s.owner, 'Na etapa temporária');
    await s.owner.browser.patch(`/api/items/${item}`, { stageId: extra.id });
    await s.owner.browser.post(`/api/items/${item}/trash`);

    const removed = await s.owner.browser.delete(`/api/stages/${extra.id}`, {
      moveTo: stages[0]?.id,
    });
    expect(removed.status).toBe(200);
    const [entry] = (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/trash`)).body;
    expect(entry).toMatchObject({ id: item, stageId: stages[0]?.id });
    expect(entry?.trashedAt).not.toBeNull();
  });
});

describe('straight at the database', () => {
  it('the moment and the person are the database’s to write', async () => {
    const item = await newItem(s.ana, 'Para a lixeira direto');
    expect(await bind(app, s.ana)).toBe(true);
    // A date in the past would shorten the thirty days; it becomes "now".
    const sent = await attempt(
      app,
      `UPDATE app.items SET deleted_at = '2000-01-01' WHERE id = $1`,
      [item],
    );
    expect(sent).toMatchObject({ ok: true, rowCount: 1 });
    const stored = await app.query<{ recent: boolean; deleted_by: string }>(
      `SELECT deleted_at > now() - interval '1 minute' AS recent, deleted_by
       FROM app.items WHERE id = $1`,
      [item],
    );
    expect(stored.rows).toEqual([{ recent: true, deleted_by: s.ana.id }]);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.items SET deleted_by = $1 WHERE id = $2`, [s.bruno.id, item]],
      [`UPDATE app.items SET deleted_at = '2000-01-01' WHERE id = $1`, [item]],
      [`DELETE FROM app.items WHERE id = $1`, [item]],
      [`DELETE FROM app.items`, []],
      [`TRUNCATE app.items CASCADE`, []],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(result.ok, text).toBe(false);
    }
    await app.query('ROLLBACK');
  });

  it('nothing about an item in the trash changes, nor what hangs from it', async () => {
    await s.owner.browser.patch(`/api/items/${s.itemNobody}`, { fields: { [notes]: 'Antes' } });
    await s.owner.browser.put(`/api/items/${s.itemNobody}/assignees`, { userIds: [s.ana.id] });
    await s.owner.browser.post(`/api/items/${s.itemNobody}/trash`);
    expect(await bind(app, s.owner)).toBe(true);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.items SET title = 'mexido' WHERE id = $1`, [s.itemNobody]],
      [`UPDATE app.items SET description = 'mexido' WHERE id = $1`, [s.itemNobody]],
      [`UPDATE app.items SET list_id = $1 WHERE id = $2`, [s.perfis, s.itemNobody]],
      [`UPDATE app.item_field_values SET value = '"mexido"' WHERE item_id = $1`, [s.itemNobody]],
      [`DELETE FROM app.item_field_values WHERE item_id = $1`, [s.itemNobody]],
      [
        `INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)`,
        [s.itemNobody, s.bruno.id],
      ],
      [`DELETE FROM app.item_assignees WHERE item_id = $1`, [s.itemNobody]],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(result, text).toMatchObject({ ok: false, code: 'CB003' });
    }
    // Coming back is one change on its own, not a way to slip another one in.
    const sneaky = await attempt(
      app,
      `UPDATE app.items SET deleted_at = NULL, title = 'mexido' WHERE id = $1`,
      [s.itemNobody],
    );
    expect(sneaky).toMatchObject({ ok: false, code: 'CB003' });
    const plain = await attempt(app, `UPDATE app.items SET deleted_at = NULL WHERE id = $1`, [
      s.itemNobody,
    ]);
    expect(plain).toMatchObject({ ok: true, rowCount: 1 });
    // ...and so is going in.
    const both = await attempt(
      app,
      `UPDATE app.items SET deleted_at = now(), title = 'mexido' WHERE id = $1`,
      [s.itemNobody],
    );
    expect(both).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
  });

  it('an employee sees in the trash only what was theirs', async () => {
    await s.owner.browser.post(`/api/items/${s.itemBruno}/trash`);
    expect(await bind(app, s.ana)).toBe(true);
    const seen = await app.query<{ id: string }>(
      'SELECT id FROM app.items WHERE deleted_at IS NOT NULL',
    );
    expect(seen.rows.map((row) => row.id)).not.toContain(s.itemBruno);
    // Not Ana's to bring back, by any route.
    const restore = await attempt(app, `UPDATE app.items SET deleted_at = NULL WHERE id = $1`, [
      s.itemBruno,
    ]);
    expect(restore).toMatchObject({ ok: true, rowCount: 0 });
    await app.query('ROLLBACK');
    expect(await trashed(s.owner, s.tarefas)).toContain(s.itemBruno);
  });

  it('after thirty days the item is removed for good, with all that hung from it', async () => {
    const old = await newItem(s.owner, 'Velho na lixeira');
    const recent = await newItem(s.owner, 'Recente na lixeira');
    for (const item of [old, recent]) {
      await s.owner.browser.patch(`/api/items/${item}`, { fields: { [notes]: 'algo' } });
      await s.owner.browser.put(`/api/items/${item}/assignees`, { userIds: [s.ana.id] });
      await s.owner.browser.post(`/api/items/${item}/trash`);
    }
    // Time passes. Not even the database's owner can backdate an item in the trash
    // without first switching off the guard, which is what the test does here.
    await expect(
      env.admin.query(
        `UPDATE app.items SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [old],
      ),
    ).rejects.toMatchObject({ code: 'CB003' });
    await env.admin.query('ALTER TABLE app.items DISABLE TRIGGER trash_guard');
    try {
      await env.admin.query(
        `UPDATE app.items SET deleted_at = now() - interval '31 days' WHERE id = $1`,
        [old],
      );
      await env.admin.query(
        `UPDATE app.items SET deleted_at = now() - interval '29 days' WHERE id = $1`,
        [recent],
      );
    } finally {
      await env.admin.query('ALTER TABLE app.items ENABLE TRIGGER trash_guard');
    }

    // The application runs this as often as it likes; the database decides what is old enough.
    const purged = await app.query<{ purged: number }>('SELECT app.purge_trash() AS purged');
    expect(purged.rows).toEqual([{ purged: 1 }]);
    const again = await app.query<{ purged: number }>('SELECT app.purge_trash() AS purged');
    expect(again.rows).toEqual([{ purged: 0 }]);

    const left = async (table: string, item: string): Promise<number> =>
      (
        await env.admin.query(
          `SELECT 1 FROM ${table} WHERE ${table === 'app.items' ? 'id' : 'item_id'} = $1`,
          [item],
        )
      ).rowCount ?? -1;
    for (const table of [
      'app.items',
      'app.item_field_values',
      'app.item_assignees',
      'app.item_changes',
      'app.item_stage_history',
    ]) {
      expect(await left(table, old), table).toBe(0);
      expect(await left(table, recent), table).toBeGreaterThan(0);
    }
    const record = await env.admin.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit.log WHERE action = 'items.purged' ORDER BY seq DESC LIMIT 1`,
    );
    expect(record.rows).toEqual([{ metadata: { count: 1 } }]);
    const chain = await env.admin.query<{ ok: boolean; broken_seq: string | null }>(
      'SELECT ok, broken_seq FROM audit.verify_chain()',
    );
    expect(chain.rows[0]).toMatchObject({ ok: true, broken_seq: null });
  });
});
