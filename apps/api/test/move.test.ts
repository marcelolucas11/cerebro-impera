import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Moving an item to another list: who may, where it lands, and which values
 * go along. First through the API, then straight at the database.
 */

interface ErrorBody {
  error: { code: string };
}
interface Item {
  id: string;
  listId: string;
  stageId: string;
  fields: Record<string, unknown>;
}
interface Field {
  id: string;
  name: string;
  config: { options?: { id: string; name: string }[]; currency?: string };
}
interface Stage {
  id: string;
  name: string;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
/** A list in the same space as Tarefas, where Ana and Bruno also edit their own items. */
let campanhas: string;
const tarefas = {} as Record<'supplier' | 'value' | 'notes' | 'only', Field>;
const campanhasFields = {} as Record<'supplier' | 'value' | 'notes', Field>;

const field = async (person: Person, list: string, body: object): Promise<Field> => {
  const created = await person.browser.post<Field>(`/api/lists/${list}/fields`, body);
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  return created.body;
};
const stagesOf = async (list: string): Promise<Stage[]> =>
  (await s.owner.browser.get<Stage[]>(`/api/lists/${list}/stages`)).body;
const itemIn = async (person: Person, list: string, id: string): Promise<Item | undefined> =>
  (await person.browser.get<Item[]>(`/api/lists/${list}/items`)).body.find((i) => i.id === id);

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const o = s.owner.browser;

  tarefas.supplier = await field(s.owner, s.tarefas, {
    name: 'Fornecedor',
    kind: 'select',
    config: { options: [{ name: 'Alfa' }, { name: 'Beta' }] },
  });
  tarefas.value = await field(s.owner, s.tarefas, { name: 'Valor', kind: 'money' });
  tarefas.notes = await field(s.owner, s.tarefas, { name: 'Notas', kind: 'text' });
  tarefas.only = await field(s.owner, s.tarefas, { name: 'Só aqui', kind: 'text' });

  campanhas = (
    await o.post<{ id: string }>('/api/lists', { spaceId: s.operacao, name: 'Campanhas' })
  ).body.id;
  for (const person of [s.ana, s.bruno]) {
    const granted = await o.put('/api/grants', {
      userId: person.id,
      scopeType: 'list',
      scopeId: campanhas,
      level: 'edit',
      itemScope: 'assigned',
    });
    expect(granted.status).toBe(200);
  }
  // The same fields, copied: they count as the same field in both lists.
  const copied = await o.post<{ created: Field[] }>(`/api/lists/${campanhas}/fields/copy`, {
    fromListId: s.tarefas,
    fieldIds: [tarefas.supplier.id, tarefas.value.id, tarefas.notes.id],
  });
  const [supplier, value, notes] = copied.body.created;
  if (!supplier || !value || !notes) throw new Error('copy failed');
  Object.assign(campanhasFields, { supplier, value, notes });
  // A third option only here, and a different currency for the money field.
  const alfa = supplier.config.options?.[0];
  const beta = supplier.config.options?.[1];
  campanhasFields.supplier = (
    await o.patch<Field>(`/api/fields/${supplier.id}`, {
      config: { options: [alfa, beta, { name: 'Gama' }] },
    })
  ).body;
  campanhasFields.value = (
    await o.patch<Field>(`/api/fields/${value.id}`, { config: { currency: 'USD' } })
  ).body;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('moving an item to another list', () => {
  it('lands it on the first stage there, or the one chosen, and the history says so', async () => {
    const [first, second] = await stagesOf(campanhas);
    const moved = await s.owner.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: campanhas,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ listId: campanhas, stageId: first?.id });
    expect(await itemIn(s.owner, s.tarefas, s.itemNobody)).toBeUndefined();
    expect(await itemIn(s.owner, campanhas, s.itemNobody)).toBeDefined();

    const back = await s.owner.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: s.tarefas,
    });
    expect(back.body.listId).toBe(s.tarefas);
    const again = await s.owner.browser.post<Item>(`/api/items/${s.itemNobody}/move`, {
      listId: campanhas,
      stageId: second?.id,
    });
    expect(again.body.stageId).toBe(second?.id);

    const story = (
      await s.owner.browser.get<{ what: string; old: unknown; new: unknown }[]>(
        `/api/items/${s.itemNobody}/history`,
      )
    ).body;
    // Newest first: one move is two lines, the list and the stage it landed on.
    expect(story.slice(0, 2).map((change) => [change.what, change.old, change.new])).toEqual([
      ['stage', expect.anything(), { id: second?.id, name: second?.name }],
      ['list', s.tarefas, campanhas],
    ]);
    await s.owner.browser.post(`/api/items/${s.itemNobody}/move`, { listId: s.tarefas });
  });

  it('takes along the values of the fields both lists share, when they mean the same there', async () => {
    const [alfa, beta] = tarefas.supplier.config.options ?? [];
    const item = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
        title: 'Perfil para mover',
        fields: {
          [tarefas.supplier.id]: alfa?.id,
          [tarefas.value.id]: 150_000,
          [tarefas.notes.id]: 'Vai junto',
          [tarefas.only.id]: 'Fica aqui',
        },
      })
    ).body;

    const moved = await s.owner.browser.post<Item>(`/api/items/${item.id}/move`, {
      listId: campanhas,
    });
    // Same field, same option, same text: along it goes. The money field there is
    // in dollars, so reais would mean something else: it stays behind. "Só aqui"
    // has no counterpart there.
    expect(moved.body.fields).toEqual({
      [campanhasFields.supplier.id]: alfa?.id,
      [campanhasFields.notes.id]: 'Vai junto',
    });

    // Changed over there, then back: the change comes back too, and what stayed behind reappears.
    await s.owner.browser.patch(`/api/items/${item.id}`, {
      fields: { [campanhasFields.supplier.id]: beta?.id, [campanhasFields.notes.id]: 'Mudou lá' },
    });
    const back = await s.owner.browser.post<Item>(`/api/items/${item.id}/move`, {
      listId: s.tarefas,
    });
    expect(back.body.fields).toEqual({
      [tarefas.supplier.id]: beta?.id,
      [tarefas.value.id]: 150_000,
      [tarefas.notes.id]: 'Mudou lá',
      [tarefas.only.id]: 'Fica aqui',
    });
  });

  it('leaves behind an option the other list does not have', async () => {
    const gama = campanhasFields.supplier.config.options?.find((o) => o.name === 'Gama');
    const item = (
      await s.owner.browser.post<Item>(`/api/lists/${campanhas}/items`, {
        title: 'Com opção só de lá',
        fields: { [campanhasFields.supplier.id]: gama?.id, [campanhasFields.notes.id]: 'Texto' },
      })
    ).body;
    const moved = await s.owner.browser.post<Item>(`/api/items/${item.id}/move`, {
      listId: s.tarefas,
    });
    expect(moved.body.fields).toEqual({ [tarefas.notes.id]: 'Texto' });
  });

  it('leaves behind what a field archived here held, even if the other list still uses it', async () => {
    const item = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
        title: 'Com campo arquivado',
        fields: { [tarefas.notes.id]: 'Escondido aqui' },
      })
    ).body;
    await s.owner.browser.patch(`/api/fields/${tarefas.notes.id}`, { archived: true });
    try {
      const moved = await s.owner.browser.post<Item>(`/api/items/${item.id}/move`, {
        listId: campanhas,
      });
      expect(moved.body.fields).toEqual({});
    } finally {
      await s.owner.browser.patch(`/api/fields/${tarefas.notes.id}`, { archived: false });
    }
  });

  it('is for whoever edits the item here and may edit in the list it goes to', async () => {
    // Ana moves her own item between two lists she edits, and keeps seeing it.
    const hers = await s.ana.browser.post<Item>(`/api/items/${s.itemAna}/move`, {
      listId: campanhas,
    });
    expect(hers.status).toBe(200);
    expect(await itemIn(s.ana, campanhas, s.itemAna)).toBeDefined();
    // Bruno does not see it in the new list either.
    expect(await itemIn(s.bruno, campanhas, s.itemAna)).toBeUndefined();
    await s.ana.browser.post(`/api/items/${s.itemAna}/move`, { listId: s.tarefas });

    // Not to a list she cannot see, nor to one she may only look at.
    const hidden = await s.ana.browser.post(`/api/items/${s.itemAna}/move`, { listId: s.perfis });
    expect(hidden.status).toBe(404);
    const showcase = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.financeiro,
        name: 'Vitrine',
      })
    ).body.id;
    await s.owner.browser.put('/api/grants', {
      userId: s.ana.id,
      scopeType: 'list',
      scopeId: showcase,
      level: 'view',
      itemScope: 'all',
    });
    const lookOnly = await s.ana.browser.post(`/api/items/${s.itemAna}/move`, {
      listId: showcase,
    });
    expect(lookOnly.status).toBe(403);
    // Not someone else's item, and not anything Nuno cannot see.
    expect(
      (await s.ana.browser.post(`/api/items/${s.itemBruno}/move`, { listId: campanhas })).status,
    ).toBe(404);
    expect(
      (await s.nuno.browser.post(`/api/items/${s.itemAna}/move`, { listId: campanhas })).status,
    ).toBe(404);
    expect(await itemIn(s.owner, s.tarefas, s.itemAna)).toBeDefined();
    expect(await itemIn(s.owner, s.tarefas, s.itemBruno)).toBeDefined();
  });

  it('into a sensitive list needs a recent second factor, and refuses nonsense', async () => {
    const o = s.owner.browser;
    const sameList = await o.post<ErrorBody>(`/api/items/${s.itemNobody}/move`, {
      listId: s.tarefas,
    });
    expect(sameList.body.error.code).toBe('same_list');
    const [foreignStage] = await stagesOf(s.perfis);
    const wrongStage = await o.post<ErrorBody>(`/api/items/${s.itemNobody}/move`, {
      listId: campanhas,
      stageId: foreignStage?.id,
    });
    expect(wrongStage.body.error.code).toBe('invalid_stage');
    for (const body of [{}, { listId: 'x' }, { listId: campanhas, extra: 1 }]) {
      expect((await o.post(`/api/items/${s.itemNobody}/move`, body)).status).toBe(400);
    }
    expect((await o.post(`/api/items/${randomUUID()}/move`, { listId: campanhas })).status).toBe(
      404,
    );
    expect(await itemIn(s.owner, s.tarefas, s.itemNobody)).toBeDefined();
  });

  it('does not take an item out of the trash', async () => {
    const item = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, { title: 'Jogado fora' })
    ).body;
    await s.owner.browser.post(`/api/items/${item.id}/trash`);
    const moved = await s.owner.browser.post(`/api/items/${item.id}/move`, { listId: campanhas });
    expect(moved.status).toBe(404);
  });
});

describe('straight at the database', () => {
  it('carrying values never writes into a list the person could not move the item to', async () => {
    const [alfa] = tarefas.supplier.config.options ?? [];
    await s.ana.browser.patch(`/api/items/${s.itemAna}`, {
      fields: { [tarefas.supplier.id]: alfa?.id },
    });
    expect(await bind(app, s.ana)).toBe(true);
    const into = await attempt(app, 'UPDATE app.items SET list_id = $1 WHERE id = $2', [
      s.perfis,
      s.itemAna,
    ]);
    expect(into.ok && into.rowCount === 1).toBe(false);
    await app.query('ROLLBACK');
    const leaked = await env.admin.query(
      `SELECT 1 FROM app.item_field_values v JOIN app.list_fields f ON f.id = v.field_id
       WHERE v.item_id = $1 AND f.list_id = $2`,
      [s.itemAna, s.perfis],
    );
    expect(leaked.rowCount).toBe(0);
  });

  it('values are carried by any path, and recorded as written by whoever moved the item', async () => {
    const item = (
      await s.ana.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
        title: 'Movido direto no banco',
        fields: { [tarefas.notes.id]: 'Junto' },
      })
    ).body;
    expect(await bind(app, s.ana)).toBe(true);
    const moved = await attempt(app, 'UPDATE app.items SET list_id = $1 WHERE id = $2', [
      campanhas,
      item.id,
    ]);
    expect(moved).toMatchObject({ ok: true, rowCount: 1 });
    const carried = await app.query<{ value: unknown; updated_by: string }>(
      'SELECT value, updated_by FROM app.item_field_values WHERE item_id = $1 AND field_id = $2',
      [item.id, campanhasFields.notes.id],
    );
    expect(carried.rows).toEqual([{ value: 'Junto', updated_by: s.ana.id }]);
    await app.query('ROLLBACK');
  });
});
