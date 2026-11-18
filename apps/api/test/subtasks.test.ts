import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Subtasks: items of the same list hanging from an item that is not a subtask
 * itself. Each follows the rules of any item. A family stays whole: moving or
 * trashing a parent takes its live subtasks along, and the database refuses,
 * when the transaction ends, any change that would leave one behind.
 */

interface Item {
  id: string;
  listId: string;
  stageId: string;
  parentId: string | null;
  trashedAt: string | null;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

const create = (person: Person, title: string, parentId?: string, listId = s.tarefas) =>
  person.browser.post<Item & ErrorBody>(`/api/lists/${listId}/items`, {
    title,
    ...(parentId === undefined ? {} : { parentId }),
  });
const newItem = async (title: string, parentId?: string, person: Person = s.owner) => {
  const made = await create(person, title, parentId);
  if (made.status !== 200) throw new Error(`${title}: ${JSON.stringify(made.body)}`);
  return made.body.id;
};
const row = async (id: string) =>
  (
    await env.admin.query<{
      list_id: string;
      parent_id: string | null;
      deleted_at: Date | null;
      stage_id: string;
    }>(`SELECT list_id, parent_id, deleted_at, stage_id FROM app.items WHERE id = $1`, [id])
  ).rows[0];
const freshCode = (person: Person) =>
  env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [person.id]);
const commit = async (): Promise<string | null> =>
  app.query('COMMIT').then(
    () => null,
    (error: unknown) => (error as { code?: string }).code ?? 'unknown',
  );

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  // Ana may also work in Perfis, to try to carry her items there.
  const granted = await s.owner.browser.put('/api/grants', {
    userId: s.ana.id,
    scopeType: 'list',
    scopeId: s.perfis,
    level: 'edit',
  });
  expect(granted.status).toBe(200);
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('making subtasks', () => {
  it('hangs a new item from one of the same list, and says so in its history', async () => {
    const parent = await newItem('Campanha de lançamento');
    const made = await create(s.marta, 'Criar os anúncios', parent);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ parentId: parent, listId: s.tarefas });
    const line = await env.admin.query(
      `SELECT actor, old, new FROM app.item_changes WHERE item_id = $1 AND what = 'parent'`,
      [made.body.id],
    );
    // Only the id: whoever reads the subtask may not be allowed to see the parent.
    expect(line.rows).toEqual([{ actor: s.marta.id, old: null, new: parent }]);
  });

  it('refuses a parent of another list, a subtask as parent, and one the author cannot edit', async () => {
    const parent = await newItem('Pai');
    const child = await newItem('Filha', parent);
    const elsewhere = await create(s.owner, 'Em outra lista', parent, s.perfis);
    expect(elsewhere.body.error.code).toBe('invalid_parent');
    const nested = await create(s.owner, 'Neta', child);
    expect(nested.body.error.code).toBe('invalid_parent');
    // Ana sees and edits only her own items: Bruno's is not there for her.
    expect((await create(s.ana, 'Debaixo do Bruno', s.itemBruno)).status).toBe(404);
  });

  it('follows the rules of any item, not its parent’s', async () => {
    // Under Ana's item, made by Marta for nobody: not Ana's to see.
    const hidden = await newItem('Conferir orçamento', s.itemAna, s.marta);
    const hers = (await s.ana.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
    expect(hers.some((item) => item.id === hidden)).toBe(false);
    expect(hers.some((item) => item.id === s.itemAna)).toBe(true);
    // Ana's own subtask under her item is hers.
    const own = await newItem('Separar as fotos', s.itemAna, s.ana);
    const again = (await s.ana.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
    expect(again.find((item) => item.id === own)?.parentId).toBe(s.itemAna);
  });

  it('takes a subtask out from under its parent', async () => {
    const parent = await newItem('Com uma subtarefa');
    const child = await newItem('Vai sair', parent);
    const out = await s.marta.browser.patch<Item>(`/api/items/${child}`, { parentId: null });
    expect(out.body.parentId).toBeNull();
    const refused = await s.marta.browser.patch(`/api/items/${child}`, { parentId: parent });
    expect(refused.status).toBe(400);
  });
});

describe('a family moves and goes to the trash together', () => {
  it('moves a parent with its live subtasks, and a subtask alone leaves its parent', async () => {
    const parent = await newItem('Mudança');
    const kids = [await newItem('Caixa 1', parent), await newItem('Caixa 2', parent)];
    const moved = await s.marta.browser.post<Item>(`/api/items/${parent}/move`, {
      listId: s.perfis,
    });
    expect(moved.status).toBe(200);
    for (const kid of kids) {
      expect(await row(kid)).toMatchObject({ list_id: s.perfis, parent_id: parent });
    }
    const alone = await s.marta.browser.post<Item>(`/api/items/${kids[0] ?? ''}/move`, {
      listId: s.tarefas,
    });
    expect(alone.body).toMatchObject({ listId: s.tarefas, parentId: null });
  });

  it('does not move a parent that has a subtask the mover may not move', async () => {
    const theirs = await newItem('Revisar textos', s.itemAna, s.marta);
    const tried = await s.ana.browser.post<ErrorBody>(`/api/items/${s.itemAna}/move`, {
      listId: s.perfis,
    });
    expect(tried.status).toBe(409);
    expect((await row(s.itemAna))?.list_id).toBe(s.tarefas);
    expect((await row(theirs))?.list_id).toBe(s.tarefas);
  });

  it('sends a parent with subtasks to the trash only as several items: capability and code', async () => {
    const parent = await newItem('Evento');
    const kids = [await newItem('Convites', parent), await newItem('Buffet', parent)];
    const earlier = await newItem('Local', parent);
    await freshCode(s.owner);
    expect((await s.owner.browser.post(`/api/items/${earlier}/trash`, {})).status).toBe(200);
    // Marta edits the list but was not given the capability.
    expect((await s.marta.browser.post(`/api/items/${parent}/trash`, {})).status).toBe(403);
    expect((await row(parent))?.deleted_at).toBeNull();
    await freshCode(s.owner);
    expect((await s.owner.browser.post(`/api/items/${parent}/trash`, {})).status).toBe(200);
    for (const id of [parent, ...kids]) expect((await row(id))?.deleted_at).not.toBeNull();
    // Back come the parent and the subtasks that went with it; not the one trashed before.
    const back = await s.owner.browser.post<Item>(`/api/items/${parent}/restore`, {});
    expect(back.status).toBe(200);
    for (const id of [parent, ...kids]) expect((await row(id))?.deleted_at).toBeNull();
    expect((await row(earlier))?.deleted_at).not.toBeNull();
  });

  it('brings a subtask back on its own when its parent is still in the trash', async () => {
    const parent = await newItem('Viagem');
    const child = await newItem('Passagens', parent);
    await freshCode(s.owner);
    expect((await s.owner.browser.post(`/api/items/${parent}/trash`, {})).status).toBe(200);
    const back = await s.owner.browser.post<Item>(`/api/items/${child}/restore`, {});
    expect(back.body).toMatchObject({ parentId: null, trashedAt: null });
    expect((await row(parent))?.deleted_at).not.toBeNull();
  });

  it('takes subtasks along when several are chosen for the trash', async () => {
    const parent = await newItem('Lote com filhos');
    const child = await newItem('Filho do lote', parent);
    const other = await newItem('Outro do lote');
    await freshCode(s.owner);
    const done = await s.owner.browser.post<{ changed: number }>(`/api/lists/${s.tarefas}/bulk`, {
      action: 'trash',
      ids: [parent, other],
    });
    expect(done.body).toEqual({ changed: 3 });
    expect((await row(child))?.deleted_at).not.toBeNull();
    // One parent with a subtask is two items: Marta, without the capability, cannot.
    const single = await newItem('Sozinho com filho');
    await newItem('O filho', single);
    const refused = await s.marta.browser.post(`/api/lists/${s.tarefas}/bulk`, {
      action: 'trash',
      ids: [single],
    });
    expect(refused.status).toBe(403);
  });
});

describe('straight at the database', () => {
  it('hangs work only from an item its author may edit', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const under = await attempt(
      app,
      `INSERT INTO app.items (id, list_id, title, created_by, parent_id)
       VALUES (gen_random_uuid(), $1, 'Debaixo do Bruno', $2, $3)`,
      [s.tarefas, s.ana.id, s.itemBruno],
    );
    expect(under).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');
  });

  it('refuses, when the transaction ends, a family left broken by any path', async () => {
    const parent = await newItem('Família');
    const child = await newItem('Membro', parent);
    const other = await newItem('Item solto');
    const cases: [string, string, unknown[]][] = [
      ['parent moved alone', `UPDATE app.items SET list_id = $1 WHERE id = $2`, [s.perfis, parent]],
      ['subtask moved alone', `UPDATE app.items SET list_id = $1 WHERE id = $2`, [s.perfis, child]],
      ['parent trashed alone', `UPDATE app.items SET deleted_at = now() WHERE id = $1`, [parent]],
      [
        'subtask under a subtask',
        `UPDATE app.items SET parent_id = $1 WHERE id = $2`,
        [child, other],
      ],
      [
        'parent made a subtask',
        `UPDATE app.items SET parent_id = $1 WHERE id = $2`,
        [other, parent],
      ],
    ];
    for (const [name, text, values] of cases) {
      expect(await bind(app, s.owner)).toBe(true);
      const statement = await attempt(app, text, values);
      expect(statement.ok, name).toBe(true);
      expect(await commit(), name).toBe('CB003');
    }
    expect(await row(parent)).toMatchObject({
      list_id: s.tarefas,
      parent_id: null,
      deleted_at: null,
    });
    expect(await row(child)).toMatchObject({ list_id: s.tarefas, parent_id: parent });
    expect((await row(other))?.parent_id).toBeNull();

    // The whole family in one change is fine.
    expect(await bind(app, s.owner)).toBe(true);
    const together = await attempt(
      app,
      `UPDATE app.items SET list_id = $1 WHERE id = $2 OR parent_id = $2`,
      [s.perfis, parent],
    );
    expect(together).toMatchObject({ ok: true, rowCount: 2 });
    expect(await commit()).toBeNull();
    expect((await row(child))?.list_id).toBe(s.perfis);
  });

  it('refuses an item as its own parent at once, and a subtask back without its parent', async () => {
    const lone = await newItem('Sozinha');
    expect(await bind(app, s.owner)).toBe(true);
    const self = await attempt(app, `UPDATE app.items SET parent_id = id WHERE id = $1`, [lone]);
    expect(self).toMatchObject({ ok: false, code: '23514' });
    await app.query('ROLLBACK');

    const parent = await newItem('Pai na lixeira');
    const child = await newItem('Filha na lixeira', parent);
    await freshCode(s.owner);
    expect((await s.owner.browser.post(`/api/items/${parent}/trash`, {})).status).toBe(200);
    expect(await bind(app, s.owner)).toBe(true);
    const back = await attempt(app, `UPDATE app.items SET deleted_at = NULL WHERE id = $1`, [
      child,
    ]);
    expect(back.ok).toBe(true);
    expect(await commit()).toBe('CB003');
    expect((await row(child))?.deleted_at).not.toBeNull();
  });

  it('changes nothing about an item in the trash, its parent and dates included', async () => {
    const parent = await newItem('Destino');
    const gone = await newItem('Jogado fora');
    await freshCode(s.owner);
    expect((await s.owner.browser.post(`/api/items/${gone}/trash`, {})).status).toBe(200);
    expect(await bind(app, s.owner)).toBe(true);
    for (const [text, values] of [
      [`UPDATE app.items SET parent_id = $2 WHERE id = $1`, [gone, parent]],
      [`UPDATE app.items SET priority = 1 WHERE id = $1`, [gone]],
      [`UPDATE app.items SET due_date = '2026-12-01' WHERE id = $1`, [gone]],
    ] as const) {
      expect(await attempt(app, text, [...values]), text).toMatchObject({
        ok: false,
        code: 'CB003',
      });
    }
    await app.query('ROLLBACK');
  });
});
