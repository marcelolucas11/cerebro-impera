import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Two small lookups answer only about what the caller sees: whether the parent
 * of an item still holds subtasks, and the title of the form that made an item.
 */

interface Item {
  id: string;
  parentId: string | null;
  trashedAt: string | null;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const newItem = async (title: string, parentId?: string): Promise<string> => {
  const made = await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
    title,
    ...(parentId === undefined ? {} : { parentId }),
  });
  if (made.status !== 200) throw new Error(`${title}: ${JSON.stringify(made.body)}`);
  return made.body.id;
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
});
afterEach(async () => {
  await app.query('ROLLBACK');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('whether a parent still holds subtasks', () => {
  it('is asked about an item the caller sees, never about any item and any list', async () => {
    const parent = await newItem('Mudança de escritório');
    const child = await newItem('Caixas', parent);

    expect(await bind(app, s.marta)).toBe(true);
    const old = await attempt(app, 'SELECT app.parent_usable($1, $2)', [parent, s.tarefas]);
    expect(old.code).toBe('42501');
    const seen = await attempt(app, 'SELECT app.parent_still_usable($1) AS ok', [child]);
    expect(seen.rows[0]).toEqual({ ok: true });
    // An item with no parent has nothing to say.
    expect(
      (await attempt(app, 'SELECT app.parent_still_usable($1) AS ok', [parent])).rows[0],
    ).toEqual({ ok: null });
    await app.query('COMMIT');

    // Nuno does not see the list: no answer, whatever the parent's state.
    expect(await bind(app, s.nuno)).toBe(true);
    expect(
      (await attempt(app, 'SELECT app.parent_still_usable($1) AS ok', [child])).rows[0],
    ).toEqual({
      ok: null,
    });
    await app.query('COMMIT');

    // With the parent in the trash, whoever sees the subtask learns it no longer holds it.
    await env.admin.query('UPDATE app.items SET deleted_at = now() WHERE id = ANY($1::uuid[])', [
      [parent, child],
    ]);
    expect(await bind(app, s.marta)).toBe(true);
    expect(
      (await attempt(app, 'SELECT app.parent_still_usable($1) AS ok', [child])).rows[0],
    ).toEqual({
      ok: false,
    });
  });

  it('still lets a subtask come back on its own when its parent is gone', async () => {
    const parent = await newItem('Feira');
    const child = await newItem('Estande', parent);
    const kept = await newItem('Folhetos', parent);
    await env.admin.query('UPDATE app.items SET deleted_at = now() WHERE id = ANY($1::uuid[])', [
      [parent, child, kept],
    ]);
    // Back with its parent still in the trash: it comes back on its own.
    const alone = await s.owner.browser.post<Item>(`/api/items/${child}/restore`, {});
    expect(alone.body).toMatchObject({ parentId: null, trashedAt: null });
    // Back with its parent there again: it stays under it.
    await env.admin.query('UPDATE app.items SET deleted_at = NULL WHERE id = $1', [parent]);
    const under = await s.owner.browser.post<Item>(`/api/items/${kept}/restore`, {});
    expect(under.body).toMatchObject({ parentId: parent, trashedAt: null });
  });
});

describe('the title of a form', () => {
  it('goes only to whoever sees the form’s list', async () => {
    const made = await env.admin.query<{ id: string }>(
      `INSERT INTO app.forms (list_id, title, title_label, run_as)
       VALUES ($1, 'Inscrições', 'Nome', $2), ($1, 'Pedidos de orçamento', 'Empresa', $2)
       RETURNING id`,
      [s.tarefas, s.owner.id],
    );
    const form = made.rows[1]?.id;

    expect(await bind(app, s.ana)).toBe(true);
    expect((await attempt(app, 'SELECT app.form_title($1) AS t', [form])).rows[0]).toEqual({
      t: 'Pedidos de orçamento',
    });
    await app.query('COMMIT');

    expect(await bind(app, s.nuno)).toBe(true);
    expect((await attempt(app, 'SELECT app.form_title($1) AS t', [form])).rows[0]).toEqual({
      t: null,
    });
  });
});
