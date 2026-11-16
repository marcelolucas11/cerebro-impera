import { randomUUID } from 'node:crypto';
import {
  FIELD_KINDS,
  fieldConfigProblem,
  fieldValueProblem,
  type FieldConfig,
  type FieldKind,
} from '@cerebro/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import {
  attempt,
  bind,
  buildScenario,
  connectAs,
  type Attempt,
  type Scenario,
} from './support/scenario.js';

/*
 * Custom fields: what a list records about each item, who may change that, and
 * what a value may be. First through the API, then straight at the database
 * with the API's own credentials.
 */

interface ErrorBody {
  error: { code: string; details?: { fieldId?: string; problem?: string } };
}
interface Option {
  id: string;
  name: string;
  color: string;
  archived?: boolean;
}
interface Field {
  id: string;
  listId: string;
  originId: string;
  name: string;
  kind: FieldKind;
  config: { options?: Option[]; currency?: string; max?: number };
  position: number;
  archived: boolean;
}
interface Item {
  id: string;
  title: string;
  fields: Record<string, unknown>;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;

/** Fields of "Tarefas", created once by the owner and used throughout. */
const f = {} as Record<
  'supplier' | 'notes' | 'bought' | 'value' | 'tags' | 'done' | 'link' | 'score' | 'count',
  Field
>;

const fieldsOf = async (person: Person, list: string): Promise<Field[]> => {
  const response = await person.browser.get<Field[]>(`/api/lists/${list}/fields`);
  expect(response.status).toBe(200);
  return response.body;
};
const itemsOf = async (person: Person, list: string): Promise<Item[]> =>
  (await person.browser.get<Item[]>(`/api/lists/${list}/items`)).body;
const itemOf = async (person: Person, list: string, id: string): Promise<Item | undefined> =>
  (await itemsOf(person, list)).find((item) => item.id === id);
const newField = async (
  person: Person,
  list: string,
  body: Record<string, unknown>,
): Promise<Field> => {
  const response = await person.browser.post<Field>(`/api/lists/${list}/fields`, body);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
};
const option = (field: Field, name: string): Option => {
  const found = field.config.options?.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no option called ${name}`);
  return found;
};

const REFUSALS = new Set(['42501', 'CB001', 'CB002', 'CB003', '23514']);
const refused = (result: Attempt): boolean =>
  result.ok ? result.rowCount === 0 : REFUSALS.has(result.code ?? '');

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  f.supplier = await newField(s.owner, s.tarefas, {
    name: 'Fornecedor',
    kind: 'select',
    config: { options: [{ name: 'Alfa', color: '#58B98A' }, { name: 'Beta' }] },
  });
  f.notes = await newField(s.owner, s.tarefas, { name: 'Observações', kind: 'long_text' });
  f.bought = await newField(s.owner, s.tarefas, { name: 'Data de compra', kind: 'date' });
  f.value = await newField(s.owner, s.tarefas, { name: 'Valor', kind: 'money' });
  f.tags = await newField(s.owner, s.tarefas, {
    name: 'Marcadores',
    kind: 'labels',
    config: { options: [{ name: 'Urgente' }, { name: 'Cliente novo' }, { name: 'Revisar' }] },
  });
  f.done = await newField(s.owner, s.tarefas, { name: 'Conferido', kind: 'checkbox' });
  f.link = await newField(s.owner, s.tarefas, { name: 'Painel', kind: 'url' });
  f.score = await newField(s.owner, s.tarefas, {
    name: 'Qualidade',
    kind: 'rating',
    config: { max: 3 },
  });
  f.count = await newField(s.owner, s.tarefas, { name: 'Quantidade', kind: 'number' });
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the fields of a list', () => {
  it('can be of every kind, each starting with the settings its kind needs', async () => {
    const list = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.operacao,
        name: 'Todos os tipos',
      })
    ).body.id;
    for (const [position, kind] of FIELD_KINDS.entries()) {
      const created = await newField(s.owner, list, { name: `Campo ${kind}`, kind });
      expect(created).toMatchObject({ listId: list, kind, position, archived: false });
      expect(created.originId).toBe(created.id);
      expect(fieldConfigProblem(kind, created.config), kind).toBeNull();
    }
    expect(f.value.config).toEqual({ currency: 'BRL' });
    expect(f.score.config).toEqual({ max: 3 });
    expect(f.supplier.config.options?.map((each) => [each.name, each.color])).toEqual([
      ['Alfa', '#58b98a'],
      ['Beta', '#9ba6b8'],
    ]);
    expect((await fieldsOf(s.owner, list)).map((each) => each.kind)).toEqual([...FIELD_KINDS]);
  });

  it('are visible to whoever can open the list, and to nobody else', async () => {
    expect((await fieldsOf(s.ana, s.tarefas)).map((each) => each.name)).toEqual([
      'Fornecedor',
      'Observações',
      'Data de compra',
      'Valor',
      'Marcadores',
      'Conferido',
      'Painel',
      'Qualidade',
      'Quantidade',
    ]);
    for (const list of [s.perfis, s.dinheiro, randomUUID()]) {
      expect((await s.ana.browser.get(`/api/lists/${list}/fields`)).status).toBe(404);
    }
    expect((await s.nuno.browser.get(`/api/lists/${s.tarefas}/fields`)).status).toBe(404);
    // The archived ones are part of managing the list, not of reading it.
    expect((await s.ana.browser.get(`/api/lists/${s.tarefas}/fields?archived=1`)).status).toBe(403);
  });

  it('follow the same rule as the items of a sensitive list', async () => {
    await expireStepUp(env, s.owner);
    const closed = await s.owner.browser.get<ErrorBody>(`/api/lists/${s.dinheiro}/fields`);
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect(await fieldsOf(s.owner, s.dinheiro)).toEqual([]);
  });

  it('are changed only by whoever manages the list', async () => {
    // Ana edits items in this list; what the list records is not hers to change.
    const b = s.ana.browser;
    const ids = (await fieldsOf(s.owner, s.tarefas)).map((each) => each.id);
    expect(
      (await b.post(`/api/lists/${s.tarefas}/fields`, { name: 'Meu', kind: 'text' })).status,
    ).toBe(403);
    expect((await b.patch(`/api/fields/${f.notes.id}`, { name: 'Outro' })).status).toBe(403);
    expect((await b.patch(`/api/fields/${f.notes.id}`, { archived: true })).status).toBe(403);
    expect((await b.put(`/api/lists/${s.tarefas}/fields/order`, { ids })).status).toBe(403);
    expect(
      (await b.post(`/api/lists/${s.tarefas}/fields/copy`, { fromListId: s.tarefas })).status,
    ).toBe(403);
    // Nuno cannot open the list at all: for him none of this exists.
    const n = s.nuno.browser;
    expect(
      (await n.post(`/api/lists/${s.tarefas}/fields`, { name: 'Meu', kind: 'text' })).status,
    ).toBe(404);
    expect((await n.patch(`/api/fields/${f.notes.id}`, { name: 'Outro' })).status).toBe(404);
    expect((await n.patch(`/api/fields/${randomUUID()}`, { name: 'Outro' })).status).toBe(404);

    expect((await fieldsOf(s.owner, s.tarefas)).map((each) => each.id)).toEqual(ids);
  });

  it('have unique names within a list, whatever the capitalisation', async () => {
    const repeated = await s.owner.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/fields`, {
      name: 'FORNECEDOR',
      kind: 'text',
    });
    expect(repeated.status).toBe(409);
    const renamed = await s.owner.browser.patch<ErrorBody>(`/api/fields/${f.notes.id}`, {
      name: 'valor',
    });
    expect(renamed.status).toBe(409);
    // The same name in another list is fine.
    const elsewhere = await newField(s.marta, s.perfis, { name: 'Fornecedor', kind: 'text' });
    expect(elsewhere.listId).toBe(s.perfis);
  });

  it('refuse a kind that does not exist, settings of another kind and anything unexpected', async () => {
    const bad: Record<string, unknown>[] = [
      { name: 'X', kind: 'senha' },
      { name: '', kind: 'text' },
      { name: 'X', kind: 'text', config: { currency: 'BRL' } },
      { name: 'X', kind: 'money', config: { currency: 'reais' } },
      { name: 'X', kind: 'money', config: { options: [{ name: 'A' }] } },
      { name: 'X', kind: 'rating', config: { max: 50 } },
      { name: 'X', kind: 'select', config: { max: 5 } },
      { name: 'X', kind: 'select', config: { options: [{ name: 'A' }, { name: 'a' }] } },
      { name: 'X', kind: 'select', config: { options: [{ name: 'A', color: 'verde' }] } },
      { name: 'X', kind: 'select', config: { options: [{ id: randomUUID(), name: 'A' }] } },
      { name: 'X', kind: 'text', listId: s.dinheiro },
      { name: 'X', kind: 'text', originId: f.supplier.id },
    ];
    for (const body of bad) {
      const response = await s.owner.browser.post(`/api/lists/${s.perfis}/fields`, body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect((await fieldsOf(s.owner, s.perfis)).map((each) => each.name)).toEqual(['Fornecedor']);
  });

  it('keep the kind they were created with', async () => {
    const response = await s.owner.browser.patch(`/api/fields/${f.notes.id}`, { kind: 'number' });
    expect(response.status).toBe(400);
    const scale = await s.owner.browser.patch<ErrorBody>(`/api/fields/${f.score.id}`, {
      config: { max: 10 },
    });
    expect(scale.status).toBe(409);
    expect(scale.body.error.code).toBe('rating_scale_is_fixed');
    const currency = await s.owner.browser.patch<Field>(`/api/fields/${f.value.id}`, {
      config: { currency: 'USD' },
    });
    expect(currency.body.config).toEqual({ currency: 'USD' });
  });

  it('can be renamed and reordered by a manager of the list', async () => {
    const renamed = await s.marta.browser.patch<Field>(`/api/fields/${f.count.id}`, {
      name: 'Unidades',
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Unidades');

    const current = (await fieldsOf(s.owner, s.tarefas)).map((each) => each.id);
    const order = [current.at(-1) ?? '', ...current.slice(0, -1)];
    const reordered = await s.marta.browser.put<Field[]>(`/api/lists/${s.tarefas}/fields/order`, {
      ids: order,
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((each) => each.id)).toEqual(order);
    expect((await fieldsOf(s.ana, s.tarefas))[0]?.name).toBe('Unidades');

    // The order must name exactly the fields of this list: no more, no fewer, none foreign.
    const foreign = (await fieldsOf(s.owner, s.perfis))[0]?.id ?? '';
    for (const ids of [
      order.slice(1),
      [...order, randomUUID()],
      [order[0], order[0], ...order.slice(2)],
      [foreign, ...order.slice(1)],
    ]) {
      const bad = await s.marta.browser.put(`/api/lists/${s.tarefas}/fields/order`, { ids });
      expect(bad.status).toBe(400);
    }
    await s.owner.browser.put(`/api/lists/${s.tarefas}/fields/order`, { ids: current });
  });

  it('leave a trace when they change', async () => {
    const trail =
      await s.owner.browser.get<{ action: string; actorUserId: string | null }[]>(
        '/api/audit?limit=200',
      );
    const actions = trail.body.map((entry) => entry.action);
    expect(actions).toContain('list_fields.insert');
    expect(
      trail.body.some(
        (entry) => entry.action === 'list_fields.update' && entry.actorUserId === s.marta.id,
      ),
    ).toBe(true);
  });
});

describe('the options of a choice field', () => {
  it('get their ids from the server and keep them when renamed or recolored', async () => {
    const alfa = option(f.supplier, 'Alfa');
    const beta = option(f.supplier, 'Beta');
    expect(alfa.id).not.toBe(beta.id);
    const updated = await s.owner.browser.patch<Field>(`/api/fields/${f.supplier.id}`, {
      config: {
        options: [
          { id: alfa.id, name: 'Alfa Perfis', color: '#dba63f' },
          { id: beta.id, name: 'Beta' },
          { name: 'Gama' },
        ],
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.config.options?.slice(0, 2)).toEqual([
      { id: alfa.id, name: 'Alfa Perfis', color: '#dba63f' },
      { id: beta.id, name: 'Beta', color: '#9ba6b8' },
    ]);
    expect(option(updated.body, 'Gama').id).toMatch(/^[0-9a-f-]{36}$/);
    f.supplier = updated.body;
  });

  it('cannot be removed or invented, only archived', async () => {
    const [alfa, beta, gama] = f.supplier.config.options ?? [];
    const removed = await s.owner.browser.patch<ErrorBody>(`/api/fields/${f.supplier.id}`, {
      config: { options: [alfa, gama] },
    });
    expect(removed.status).toBe(409);
    expect(removed.body.error.code).toBe('option_cannot_be_removed');
    const invented = await s.owner.browser.patch<ErrorBody>(`/api/fields/${f.supplier.id}`, {
      config: { options: [alfa, beta, gama, { id: randomUUID(), name: 'Delta' }] },
    });
    expect(invented.status).toBe(400);
    expect((await fieldsOf(s.owner, s.tarefas)).find((x) => x.id === f.supplier.id)).toEqual(
      f.supplier,
    );
  });

  it('stay on the items that have them after being archived, and cannot be newly chosen', async () => {
    const [alfa, beta, gama] = f.supplier.config.options ?? [];
    const [urgent, fresh, review] = f.tags.config.options ?? [];
    await s.owner.browser.patch(`/api/items/${s.itemAna}`, {
      fields: { [f.supplier.id]: beta?.id, [f.tags.id]: [urgent?.id, fresh?.id] },
    });
    const archived = await s.owner.browser.patch<Field>(`/api/fields/${f.supplier.id}`, {
      config: { options: [alfa, { ...beta, archived: true }, gama] },
    });
    expect(option(archived.body, 'Beta').archived).toBe(true);
    f.supplier = archived.body;
    const tags = await s.owner.browser.patch<Field>(`/api/fields/${f.tags.id}`, {
      config: { options: [{ ...urgent, archived: true }, fresh, review] },
    });
    f.tags = tags.body;

    // What the item had is still there.
    const kept = await itemOf(s.owner, s.tarefas, s.itemAna);
    expect(kept?.fields[f.supplier.id]).toBe(beta?.id);
    expect(kept?.fields[f.tags.id]).toEqual([urgent?.id, fresh?.id]);

    // Another item cannot pick the archived option...
    for (const fields of [{ [f.supplier.id]: beta?.id }, { [f.tags.id]: [urgent?.id] }]) {
      const picked = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemBruno}`, {
        fields,
      });
      expect(picked.status).toBe(400);
      expect(picked.body.error.details?.problem).toBe('unknown_option');
    }
    // ...while this one may keep it next to a new choice, and lose it for good once dropped.
    const more = await s.owner.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      fields: { [f.tags.id]: [urgent?.id, review?.id] },
    });
    expect(more.body.fields[f.tags.id]).toEqual([urgent?.id, review?.id]);
    await s.owner.browser.patch(`/api/items/${s.itemAna}`, {
      fields: { [f.tags.id]: [review?.id] },
    });
    const back = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemAna}`, {
      fields: { [f.tags.id]: [urgent?.id, review?.id] },
    });
    expect(back.status).toBe(400);
  });
});

describe('the values of an item', () => {
  it('are stored for every kind and come back with the item', async () => {
    const gama = option(f.supplier, 'Gama');
    const review = option(f.tags, 'Revisar');
    const values = {
      [f.supplier.id]: gama.id,
      [f.notes.id]: 'Comprado em lote.\nConferir com o fornecedor.',
      [f.bought.id]: '2026-11-03',
      [f.value.id]: 149_990,
      [f.tags.id]: [review.id],
      [f.done.id]: false,
      [f.link.id]: 'https://exemplo.test/painel/42',
      [f.score.id]: 3,
      [f.count.id]: 12.5,
    };
    const saved = await s.owner.browser.patch<Item>(`/api/items/${s.itemNobody}`, {
      fields: values,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.fields).toEqual(values);
    expect((await itemOf(s.owner, s.tarefas, s.itemNobody))?.fields).toEqual(values);

    // An item can be born with its fields filled in.
    const born = await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
      title: 'Perfil novo',
      fields: { [f.bought.id]: '2026-11-16', [f.done.id]: true },
    });
    expect(born.status).toBe(200);
    expect(born.body.fields).toEqual({ [f.bought.id]: '2026-11-16', [f.done.id]: true });
  });

  it('change one field at a time and are cleared with an empty value', async () => {
    const before = (await itemOf(s.owner, s.tarefas, s.itemNobody))?.fields ?? {};
    const changed = await s.owner.browser.patch<Item>(`/api/items/${s.itemNobody}`, {
      fields: { [f.count.id]: 13, [f.link.id]: null },
    });
    const expected = Object.fromEntries(
      Object.entries({ ...before, [f.count.id]: 13 }).filter(([id]) => id !== f.link.id),
    );
    expect(changed.body.fields).toEqual(expected);
    // Clearing what is already empty is not an error.
    const again = await s.owner.browser.patch(`/api/items/${s.itemNobody}`, {
      fields: { [f.link.id]: null },
    });
    expect(again.status).toBe(200);
  });

  it('are refused when they do not fit the field, and nothing is saved by halves', async () => {
    const before = await itemOf(s.owner, s.tarefas, s.itemNobody);
    const bad: [Field, unknown, string][] = [
      [f.bought, '2026-02-30', 'invalid_date'],
      [f.bought, 'amanhã', 'invalid_date'],
      [f.value, 19.9, 'not_whole'],
      [f.value, '1500', 'wrong_type'],
      [f.score, 4, 'out_of_range'],
      [f.done, 'sim', 'wrong_type'],
      [f.link, 'javascript:alert(1)', 'invalid_url'],
      [f.supplier, 'Gama', 'unknown_option'],
      [f.supplier, randomUUID(), 'unknown_option'],
      [f.tags, [], 'empty'],
      [f.notes, '   ', 'empty'],
      [f.count, true, 'wrong_type'],
    ];
    for (const [field, value, problem] of bad) {
      const response = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
        title: 'Não deveria mudar',
        fields: { [f.count.id]: 99, [field.id]: value },
      });
      expect(response.status, `${field.name}: ${JSON.stringify(value)}`).toBe(400);
      expect(response.body.error.code).toBe('invalid_field_value');
      expect(response.body.error.details).toEqual({ fieldId: field.id, problem });
    }
    // Shapes no field accepts never get as far as a field.
    for (const value of [{ a: 1 }, [1, 2], ['não é um id']]) {
      const response = await s.owner.browser.patch(`/api/items/${s.itemNobody}`, {
        fields: { [f.notes.id]: value },
      });
      expect(response.status).toBe(400);
    }
    expect(await itemOf(s.owner, s.tarefas, s.itemNobody)).toEqual(before);
  });

  it('belong only to fields of the item’s own list that are still in use', async () => {
    const foreign = (await fieldsOf(s.owner, s.perfis))[0]?.id ?? '';
    for (const fieldId of [foreign, randomUUID()]) {
      const response = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
        fields: { [fieldId]: 'x' },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('invalid_field');
    }
    const created = await s.owner.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/items`, {
      title: 'Com campo de outra lista',
      fields: { [foreign]: 'x' },
    });
    expect(created.status).toBe(400);
    expect((await itemsOf(s.owner, s.tarefas)).some((i) => i.title.startsWith('Com campo'))).toBe(
      false,
    );
  });

  it('are written by whoever may edit the item, and by nobody else', async () => {
    const hers = await s.ana.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      fields: { [f.notes.id]: 'Anotado pela Ana' },
    });
    expect(hers.status).toBe(200);
    expect(hers.body.fields[f.notes.id]).toBe('Anotado pela Ana');
    // Bruno's item does not exist for her; neither does anything in it.
    const his = await s.ana.browser.patch(`/api/items/${s.itemBruno}`, {
      fields: { [f.notes.id]: 'Invadido' },
    });
    expect(his.status).toBe(404);
    const nunos = await s.nuno.browser.patch(`/api/items/${s.itemAna}`, {
      fields: { [f.notes.id]: 'Invadido' },
    });
    expect(nunos.status).toBe(404);
    expect((await itemOf(s.owner, s.tarefas, s.itemBruno))?.fields[f.notes.id]).toBeUndefined();
  });

  it('can be read and not written by someone who may only look', async () => {
    const list = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.operacao,
        name: 'Só leitura',
      })
    ).body.id;
    const field = await newField(s.owner, list, { name: 'Situação', kind: 'text' });
    const blank = await newField(s.owner, list, { name: 'Ainda vazio', kind: 'text' });
    const item = await s.owner.browser.post<Item>(`/api/lists/${list}/items`, {
      title: 'Para consulta',
      fields: { [field.id]: 'Em dia' },
    });
    const granted = await s.owner.browser.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: list,
      level: 'view',
      itemScope: 'all',
    });
    expect(granted.status).toBe(200);

    expect((await itemOf(s.bruno, list, item.body.id))?.fields).toEqual({ [field.id]: 'Em dia' });
    for (const fields of [
      { [field.id]: 'Alterado' },
      { [field.id]: null },
      { [blank.id]: 'Preenchido' },
    ]) {
      const write = await s.bruno.browser.patch(`/api/items/${item.body.id}`, { fields });
      expect(write.status).toBe(403);
    }
    // The same person, with the API's own credentials and no API in the way.
    expect(await bind(app, s.bruno)).toBe(true);
    const read = await app.query<{ value: unknown }>(
      'SELECT value FROM app.item_field_values WHERE item_id = $1',
      [item.body.id],
    );
    expect(read.rows).toEqual([{ value: 'Em dia' }]);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.item_field_values SET value = '"Alterado"' WHERE item_id = $1`, [item.body.id]],
      [`DELETE FROM app.item_field_values WHERE item_id = $1`, [item.body.id]],
      [
        `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '"Novo"')
         ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
        [item.body.id, field.id],
      ],
      // Filling in a field that had no value yet is writing too.
      [
        `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '"Novo"')`,
        [item.body.id, blank.id],
      ],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }
    await app.query('ROLLBACK');
    expect((await itemOf(s.owner, list, item.body.id))?.fields).toEqual({ [field.id]: 'Em dia' });
  });

  it('are seen only with the items they belong to', async () => {
    await s.owner.browser.patch(`/api/items/${s.itemBruno}`, {
      fields: { [f.notes.id]: 'Segredo do Bruno', [f.value.id]: 500_000 },
    });
    const seenByAna = await itemsOf(s.ana, s.tarefas);
    expect(seenByAna.map((item) => item.id)).not.toContain(s.itemBruno);
    expect(JSON.stringify(seenByAna)).not.toContain('Segredo do Bruno');
    const seenByBruno = await itemOf(s.bruno, s.tarefas, s.itemBruno);
    expect(seenByBruno?.fields[f.notes.id]).toBe('Segredo do Bruno');
  });
});

describe('archiving a field', () => {
  it('hides it and its values without losing them, and restoring brings both back', async () => {
    const before = (await itemOf(s.owner, s.tarefas, s.itemNobody))?.fields ?? {};
    expect(before[f.bought.id]).toBe('2026-11-03');

    const archived = await s.owner.browser.patch<Field>(`/api/fields/${f.bought.id}`, {
      archived: true,
    });
    expect(archived.body.archived).toBe(true);
    expect((await fieldsOf(s.ana, s.tarefas)).map((x) => x.id)).not.toContain(f.bought.id);
    const hidden = (await itemOf(s.owner, s.tarefas, s.itemNobody))?.fields ?? {};
    expect(hidden[f.bought.id]).toBeUndefined();
    const write = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
      fields: { [f.bought.id]: '2026-12-01' },
    });
    expect(write.status).toBe(400);
    expect(write.body.error.code).toBe('invalid_field');

    // A manager still finds it among the archived ones.
    const all = await s.marta.browser.get<Field[]>(`/api/lists/${s.tarefas}/fields?archived=1`);
    expect(all.body.find((x) => x.id === f.bought.id)?.archived).toBe(true);
    // Its name is free for a new field meanwhile; then the old one cannot come back as it was.
    const twin = await newField(s.owner, s.tarefas, { name: 'Data de compra', kind: 'text' });
    const clash = await s.owner.browser.patch(`/api/fields/${f.bought.id}`, { archived: false });
    expect(clash.status).toBe(409);
    await s.owner.browser.patch(`/api/fields/${twin.id}`, { archived: true });

    const restored = await s.owner.browser.patch<Field>(`/api/fields/${f.bought.id}`, {
      archived: false,
    });
    expect(restored.body.archived).toBe(false);
    expect((await itemOf(s.owner, s.tarefas, s.itemNobody))?.fields).toEqual(before);
  });
});

describe('copying fields from another list', () => {
  it('brings the fields with their options, as the same field for totals', async () => {
    const copied = await s.marta.browser.post<{ created: Field[]; skipped: string[] }>(
      `/api/lists/${s.perfis}/fields/copy`,
      { fromListId: s.tarefas, fieldIds: [f.supplier.id, f.value.id, f.tags.id] },
    );
    expect(copied.status).toBe(200);
    // Perfis already has its own "Fornecedor".
    expect(copied.body.skipped).toEqual(['Fornecedor']);
    expect(copied.body.created.map((each) => [each.name, each.kind, each.listId])).toEqual([
      ['Valor', 'money', s.perfis],
      ['Marcadores', 'labels', s.perfis],
    ]);
    const [value, tags] = copied.body.created;
    expect(value?.originId).toBe(f.value.id);
    expect(value?.id).not.toBe(f.value.id);
    expect(value?.config).toEqual({ currency: 'USD' });
    // Options in use come along with the same ids; archived ones stay behind.
    expect(tags?.config.options).toEqual(
      f.tags.config.options?.filter((each) => each.archived !== true),
    );

    // Copying again changes nothing: the list already has those fields.
    const again = await s.marta.browser.post<{ created: Field[]; skipped: string[] }>(
      `/api/lists/${s.perfis}/fields/copy`,
      { fromListId: s.tarefas },
    );
    expect(again.body.created.map((each) => each.name)).not.toContain('Valor');
    expect(again.body.skipped).toEqual(expect.arrayContaining(['Fornecedor', 'Valor']));
    // Even under a new name, a copy is still the same field.
    await s.marta.browser.patch(`/api/fields/${value?.id}`, { name: 'Preço' });
    const renamed = await s.marta.browser.post<{ created: Field[]; skipped: string[] }>(
      `/api/lists/${s.perfis}/fields/copy`,
      { fromListId: s.tarefas, fieldIds: [f.value.id] },
    );
    expect(renamed.body).toEqual({ created: [], skipped: ['Valor'] });
  });

  it('needs the other list to be visible and this one to be managed', async () => {
    // Marta does not see "Dinheiro".
    const hidden = await s.marta.browser.post(`/api/lists/${s.perfis}/fields/copy`, {
      fromListId: s.dinheiro,
    });
    expect(hidden.status).toBe(404);
    const itself = await s.marta.browser.post(`/api/lists/${s.perfis}/fields/copy`, {
      fromListId: s.perfis,
    });
    expect(itself.status).toBe(400);
    const notOfThatList = await s.marta.browser.post(`/api/lists/${s.perfis}/fields/copy`, {
      fromListId: s.tarefas,
      fieldIds: [randomUUID()],
    });
    expect(notOfThatList.status).toBe(400);
    // A sensitive list is copied from only by someone who has just confirmed who they are.
    await expireStepUp(env, s.owner);
    const sensitive = await s.owner.browser.post<ErrorBody>(`/api/lists/${s.perfis}/fields/copy`, {
      fromListId: s.dinheiro,
    });
    expect(sensitive.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
  });
});

describe('straight at the database', () => {
  it('an employee cannot change what a list records', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.list_fields (id, list_id, name, kind)
         VALUES (gen_random_uuid(), $1, 'meu', 'text')`,
        [s.tarefas],
      ],
      [`UPDATE app.list_fields SET name = 'invadido' WHERE id = $1`, [f.notes.id]],
      [`UPDATE app.list_fields SET is_archived = true`, []],
      [`UPDATE app.list_fields SET config = '{"currency":"EUR"}' WHERE id = $1`, [f.value.id]],
      [`DELETE FROM app.list_fields`, []],
      [`TRUNCATE app.list_fields CASCADE`, []],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }
    // She sees the fields of the one list she can open.
    const visible = await app.query<{ list_id: string }>(
      'SELECT DISTINCT list_id FROM app.list_fields',
    );
    expect(visible.rows.map((row) => row.list_id)).toEqual([s.tarefas]);
    await app.query('ROLLBACK');
  });

  it('an employee reads and writes values of their own items and of no other', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const seen = await app.query<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM app.item_field_values',
    );
    const hers = await app.query<{ id: string }>('SELECT id FROM app.items');
    const mine = new Set(hers.rows.map((row) => row.id));
    expect(seen.rows.length).toBeGreaterThan(0);
    expect(seen.rows.every((row) => mine.has(row.item_id))).toBe(true);
    expect(mine.has(s.itemBruno)).toBe(false);
    expect(
      (
        await env.admin.query('SELECT 1 FROM app.item_field_values WHERE item_id = $1', [
          s.itemBruno,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);

    const own = await attempt(
      app,
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '7')
       ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      [s.itemAna, f.count.id],
    );
    expect(own).toMatchObject({ ok: true, rowCount: 1 });
    const author = await app.query<{ updated_by: string }>(
      'SELECT updated_by FROM app.item_field_values WHERE item_id = $1 AND field_id = $2',
      [s.itemAna, f.count.id],
    );
    expect(author.rows[0]?.updated_by).toBe(s.ana.id);

    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, '7')`,
        [s.itemBruno, f.count.id],
      ],
      [`UPDATE app.item_field_values SET value = '0' WHERE item_id = $1`, [s.itemBruno]],
      [`DELETE FROM app.item_field_values WHERE item_id = $1`, [s.itemBruno]],
      // Authorship is the database's to write.
      [
        `INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
         VALUES ($1, $2, '1', $3)`,
        [s.itemAna, f.score.id, s.bruno.id],
      ],
      [`UPDATE app.item_field_values SET updated_by = $1`, [s.bruno.id]],
      [`UPDATE app.item_field_values SET updated_at = '2000-01-01'`, []],
      // A value does not move to another item or another field.
      [`UPDATE app.item_field_values SET item_id = $1`, [s.itemBruno]],
      [
        `UPDATE app.item_field_values SET field_id = $1 WHERE field_id = $2`,
        [f.score.id, f.count.id],
      ],
      [`TRUNCATE app.item_field_values`, []],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }
    await app.query('ROLLBACK');
    const untouched = await env.admin.query<{ value: unknown }>(
      'SELECT value FROM app.item_field_values WHERE item_id = $1 AND field_id = $2',
      [s.itemBruno, f.value.id],
    );
    expect(untouched.rows[0]?.value).toBe(500_000);
  });

  it('a value must fit its field, whoever writes it and however', async () => {
    const foreign = (await fieldsOf(s.owner, s.perfis)).find((x) => x.kind === 'text');
    expect(await bind(app, s.owner)).toBe(true);
    const write = (fieldId: string, value: unknown): Promise<Attempt> =>
      attempt(
        app,
        `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
        [s.itemNobody, fieldId, JSON.stringify(value)],
      );
    const bad: [Field, unknown][] = [
      [f.bought, '2026-02-30'],
      [f.bought, 20261103],
      [f.value, 19.9],
      [f.value, '1500'],
      [f.score, 4],
      [f.score, 0],
      [f.done, 'true'],
      [f.link, 'javascript:alert(1)'],
      [f.supplier, 'Gama'],
      [f.supplier, option(f.supplier, 'Beta').id],
      [f.tags, []],
      [f.tags, [option(f.tags, 'Revisar').id, option(f.tags, 'Revisar').id]],
      [f.tags, option(f.tags, 'Revisar').id],
      [f.notes, ''],
      [f.notes, { rich: true }],
      [f.count, null],
      [f.count, '12'],
    ];
    for (const [field, value] of bad) {
      const result = await write(field.id, value);
      expect(result.ok, `${field.name}: ${JSON.stringify(value)}`).toBe(false);
      expect(['23514', '23502']).toContain(result.code);
    }
    expect(await write(f.count.id, 41)).toMatchObject({ ok: true });
    // A field of another list, or one that does not exist, is not a field of this item.
    expect(await write(foreign?.id ?? '', 'x')).toMatchObject({ ok: false });
    expect(await write(randomUUID(), 'x')).toMatchObject({ ok: false });
    await app.query('ROLLBACK');
  });

  it('a manager cannot change the kind of a field, move it, drop an option or delete it', async () => {
    const alfa = option(f.supplier, 'Alfa Perfis');
    expect(await bind(app, s.marta)).toBe(true);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.list_fields SET kind = 'text' WHERE id = $1`, [f.value.id]],
      [`UPDATE app.list_fields SET list_id = $1 WHERE id = $2`, [s.perfis, f.value.id]],
      [`UPDATE app.list_fields SET origin_id = $1 WHERE id = $2`, [f.count.id, f.value.id]],
      [`UPDATE app.list_fields SET created_by = $1`, [s.owner.id]],
      [
        `UPDATE app.list_fields SET config = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ options: [alfa] }), f.supplier.id],
      ],
      [`UPDATE app.list_fields SET config = '{"max": 10}' WHERE id = $1`, [f.score.id]],
      [`UPDATE app.list_fields SET config = '{"currency": "reais"}' WHERE id = $1`, [f.value.id]],
      [`UPDATE app.list_fields SET config = '{"anything": 1}' WHERE id = $1`, [f.notes.id]],
      [`DELETE FROM app.list_fields WHERE id = $1`, [f.notes.id]],
      // Lists she does not manage.
      [
        `INSERT INTO app.list_fields (id, list_id, name, kind)
         VALUES (gen_random_uuid(), $1, 'Conta', 'text')`,
        [s.dinheiro],
      ],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }
    // In a list she manages, a new field is hers to create, and is recorded as hers.
    const id = randomUUID();
    const allowed = await attempt(
      app,
      `INSERT INTO app.list_fields (id, list_id, name, kind) VALUES ($1, $2, 'Criado direto', 'checkbox')`,
      [id, s.tarefas],
    );
    expect(allowed).toMatchObject({ ok: true, rowCount: 1 });
    const created = await app.query<{ own_origin: boolean; created_by: string }>(
      'SELECT origin_id = id AS own_origin, created_by FROM app.list_fields WHERE id = $1',
      [id],
    );
    expect(created.rows).toEqual([{ own_origin: true, created_by: s.marta.id }]);
    await app.query('ROLLBACK');
  });

  it('a copy can only claim the origin of a field its author can see', async () => {
    const hidden = randomUUID();
    await env.admin.query(
      `INSERT INTO app.list_fields (id, list_id, origin_id, name, kind, created_by)
       VALUES ($1, $2, $1, 'Conta bancária', 'text', $3)`,
      [hidden, s.dinheiro, s.owner.id],
    );
    const destination = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.operacao,
        name: 'Destino das cópias',
      })
    ).body.id;
    expect(await bind(app, s.marta)).toBe(true);
    const claim = (origin: string, kind: string): Promise<Attempt> =>
      attempt(
        app,
        `INSERT INTO app.list_fields (id, list_id, origin_id, name, kind)
         VALUES (gen_random_uuid(), $1, $2, $3, $4::app.field_kind)`,
        [destination, origin, `Cópia ${randomUUID().slice(0, 8)}`, kind],
      );
    // A field in a list she cannot see, one that does not exist, and one of another kind.
    expect(await claim(hidden, 'text')).toMatchObject({ ok: false, code: 'CB001' });
    expect(await claim(randomUUID(), 'text')).toMatchObject({ ok: false, code: 'CB001' });
    expect(await claim(f.notes.id, 'number')).toMatchObject({ ok: false, code: 'CB001' });
    expect(await claim(f.notes.id, 'long_text')).toMatchObject({ ok: true, rowCount: 1 });
    // And each origin once per list.
    expect(await claim(f.notes.id, 'long_text')).toMatchObject({ ok: false, code: '23505' });
    await app.query('ROLLBACK');
  });

  it('values of an archived field, or of a list the item left, are out of reach', async () => {
    const count = async (): Promise<number> =>
      (
        await app.query(
          'SELECT 1 FROM app.item_field_values WHERE item_id = $1 AND field_id = $2',
          [s.itemNobody, f.count.id],
        )
      ).rowCount ?? 0;
    expect(await bind(app, s.owner)).toBe(true);
    expect(await count()).toBe(1);

    await app.query('UPDATE app.list_fields SET is_archived = true WHERE id = $1', [f.count.id]);
    expect(await count()).toBe(0);
    expect(
      refused(
        await attempt(
          app,
          `UPDATE app.item_field_values SET value = '1' WHERE item_id = $1 AND field_id = $2`,
          [s.itemNobody, f.count.id],
        ),
      ),
    ).toBe(true);
    await app.query('UPDATE app.list_fields SET is_archived = false WHERE id = $1', [f.count.id]);
    expect(await count()).toBe(1);

    // The item moves to a list that does not have this field: the value stays behind, unseen.
    await app.query('UPDATE app.items SET list_id = $1 WHERE id = $2', [s.perfis, s.itemNobody]);
    expect(await count()).toBe(0);
    await app.query('UPDATE app.items SET list_id = $1 WHERE id = $2', [s.tarefas, s.itemNobody]);
    expect(await count()).toBe(1);
    await app.query('ROLLBACK');
  });

  it('the database and the API agree on what a value may be', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const OLD = '33333333-3333-4333-8333-333333333333';
    const choices: FieldConfig = {
      options: [
        { id: A, name: 'A', color: '#58b98a' },
        { id: B, name: 'B', color: '#dba63f' },
        { id: OLD, name: 'Antiga', color: '#9ba6b8', archived: true },
      ],
    };
    const cases: [FieldKind, FieldConfig, unknown, unknown?][] = [
      ['text', {}, 'Agência'],
      ['text', {}, ''],
      ['text', {}, ' \t\n'],
      ['text', {}, 'x'.repeat(500)],
      ['text', {}, 'x'.repeat(501)],
      ['text', {}, 5],
      ['long_text', {}, 'x'.repeat(20_000)],
      ['long_text', {}, 'x'.repeat(20_001)],
      ['url', {}, 'https://exemplo.test/a?b=1#c'],
      ['url', {}, 'http://exemplo.test'],
      ['url', {}, 'exemplo.test'],
      ['url', {}, 'https://exemplo.test/a b'],
      ['url', {}, 'https://'],
      ['url', {}, 'javascript:alert(1)'],
      ['email', {}, 'contato@exemplo.test'],
      ['email', {}, 'contato@exemplo'],
      ['email', {}, 'a b@exemplo.test'],
      ['email', {}, 'a@@exemplo.test'],
      ['phone', {}, '+55 (11) 91234-5678'],
      ['phone', {}, '12'],
      ['phone', {}, 'ligar'],
      ['number', {}, 0],
      ['number', {}, -12.75],
      ['number', {}, 1e15],
      ['number', {}, 1e16],
      ['number', {}, '3'],
      ['number', {}, true],
      ['money', { currency: 'BRL' }, 0],
      ['money', { currency: 'BRL' }, -1],
      ['money', { currency: 'BRL' }, 149_990],
      ['money', { currency: 'BRL' }, 0.5],
      ['rating', { max: 5 }, 1],
      ['rating', { max: 5 }, 5],
      ['rating', { max: 5 }, 6],
      ['rating', { max: 5 }, 0],
      ['rating', { max: 5 }, 1.5],
      ['checkbox', {}, true],
      ['checkbox', {}, false],
      ['checkbox', {}, 0],
      ['checkbox', {}, 'false'],
      ['date', {}, '2026-11-16'],
      ['date', {}, '2028-02-29'],
      ['date', {}, '2026-02-29'],
      ['date', {}, '2026-00-10'],
      ['date', {}, '1899-12-31'],
      ['date', {}, '2201-01-01'],
      ['date', {}, '16/11/2026'],
      ['date', {}, '2026-11-16T00:00:00Z'],
      ['datetime', {}, '2026-11-16T09:30:00Z'],
      ['datetime', {}, '2026-11-16T09:30:00.5Z'],
      ['datetime', {}, '2026-11-16T09:30:00.1234Z'],
      ['datetime', {}, '2026-11-16T09:30Z'],
      ['datetime', {}, '2026-11-16T09:30:00+00:00'],
      ['datetime', {}, '2026-11-16T25:00:00Z'],
      ['datetime', {}, '2026-11-31T09:30:00Z'],
      ['datetime', {}, '2026-11-16'],
      ['select', choices, A],
      ['select', choices, OLD],
      ['select', choices, OLD, OLD],
      ['select', choices, OLD, A],
      ['select', choices, 'A'],
      ['select', choices, [A]],
      ['select', { options: [] }, A],
      ['labels', choices, [A]],
      ['labels', choices, [A, B]],
      ['labels', choices, [B, A]],
      ['labels', choices, []],
      ['labels', choices, [A, A]],
      ['labels', choices, [A, OLD]],
      ['labels', choices, [A, OLD], [OLD, B]],
      ['labels', choices, [A, OLD], [B]],
      ['labels', choices, [A, OLD], OLD],
      ['labels', choices, [A, 3]],
      ['labels', choices, A],
      ['labels', choices, Array.from({ length: 51 }, () => A)],
    ];
    for (const [kind, config, value, previous] of cases) {
      const fromApi = fieldValueProblem(kind, config, value, previous);
      const fromDb = await env.admin.query<{ problem: string | null }>(
        'SELECT app.field_value_problem($1::app.field_kind, $2::jsonb, $3::jsonb, $4::jsonb) AS problem',
        [
          kind,
          JSON.stringify(config),
          JSON.stringify(value),
          previous === undefined ? null : JSON.stringify(previous),
        ],
      );
      expect(
        fromDb.rows[0]?.problem === null,
        `${kind} ${JSON.stringify(value)}: API says ${String(fromApi)}, database says ${String(fromDb.rows[0]?.problem)}`,
      ).toBe(fromApi === null);
    }
    const accepted = cases.filter(([k, c, v, p]) => fieldValueProblem(k, c, v, p) === null);
    expect(accepted.length).toBeGreaterThan(20);
    expect(cases.length - accepted.length).toBeGreaterThan(30);
  });

  it('the database and the API agree on what the settings of a field may be', async () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const ok = { id: A, name: 'A', color: '#58b98a' };
    const cases: [FieldKind, unknown][] = [
      ['text', {}],
      ['text', { options: [] }],
      ['text', []],
      ['checkbox', { max: 5 }],
      ['money', { currency: 'BRL' }],
      ['money', { currency: 'brl' }],
      ['money', { currency: 'BRL', max: 5 }],
      ['money', {}],
      ['rating', { max: 3 }],
      ['rating', { max: 10 }],
      ['rating', { max: 2 }],
      ['rating', { max: 11 }],
      ['rating', { max: 4.5 }],
      ['rating', { max: '5' }],
      ['rating', {}],
      ['select', { options: [] }],
      ['select', { options: [ok] }],
      ['select', { options: [{ ...ok, archived: true }] }],
      ['select', { options: [ok, { ...ok, name: 'B' }] }],
      ['select', { options: [ok, { id: A.replace('1', '2'), name: 'a', color: '#58b98a' }] }],
      [
        'select',
        {
          options: [
            { ...ok, archived: true },
            { id: A.replace('1', '2'), name: 'A', color: '#58b98a' },
          ],
        },
      ],
      ['select', { options: [{ ...ok, name: '' }] }],
      ['select', { options: [{ ...ok, name: ' A' }] }],
      ['select', { options: [{ ...ok, color: 'red' }] }],
      ['select', { options: [{ ...ok, id: 'um' }] }],
      ['select', { options: [{ ...ok, archived: 'yes' }] }],
      ['select', { options: [{ ...ok, extra: true }] }],
      ['select', { options: ['A'] }],
      ['select', { options: {} }],
      ['select', {}],
      ['labels', { options: [ok], currency: 'BRL' }],
    ];
    for (const [kind, config] of cases) {
      const fromApi = fieldConfigProblem(kind, config);
      const fromDb = await env.admin.query<{ problem: string | null }>(
        'SELECT app.field_config_problem($1::app.field_kind, $2::jsonb) AS problem',
        [kind, JSON.stringify(config)],
      );
      expect(
        fromDb.rows[0]?.problem === null,
        `${kind} ${JSON.stringify(config)}: API says ${String(fromApi)}, database says ${String(fromDb.rows[0]?.problem)}`,
      ).toBe(fromApi === null);
    }
  });
});
