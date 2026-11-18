import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * More ways to start a rule (a field changes, someone is handed the item) and
 * more for it to do (fill in or clear a field, set the due date some days
 * ahead, add a subtask). The guarantees of the first rules hold. By the API
 * and at the database.
 */

interface Rule {
  id: string;
}
interface Item {
  id: string;
  stageId: string;
  priority: number | null;
  dueDate: string | null;
  startDate: string | null;
  parentId: string | null;
  assignees: string[];
  fields: Record<string, unknown>;
  title: string;
  createdBy: string;
}
interface Run {
  outcome: string;
  detail: string | null;
}
interface ErrorBody {
  error: { code: string };
}
interface Field {
  id: string;
  config: { options: { id: string; name: string }[] };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let supplier: Field;
let alfa: string;
let beta: string;
let box: string;
let note: string;
let secret: string;

const save = (body: Record<string, unknown>, person: Person = s.owner) =>
  person.browser.post<Rule & ErrorBody>(`/api/lists/${s.tarefas}/automations`, body);
const items = async (): Promise<Item[]> =>
  (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
const itemOf = async (id: string): Promise<Item | undefined> =>
  (await items()).find((item) => item.id === id);
const newItem = async (title: string, extra: Record<string, unknown> = {}): Promise<string> =>
  (
    await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
      title,
      ...extra,
    })
  ).body.id;
const setFields = (id: string, fields: Record<string, unknown>) =>
  s.owner.browser.patch<Item & ErrorBody>(`/api/items/${id}`, { fields });
const assign = (id: string, people: Person[]) =>
  s.owner.browser.put(`/api/items/${id}/assignees`, { userIds: people.map((one) => one.id) });
const runsOf = async (id: string): Promise<Run[]> =>
  (await s.owner.browser.get<Run[]>(`/api/automations/${id}/runs`)).body;
const day = async (expression: string): Promise<string> =>
  (await env.admin.query<{ d: string }>(`SELECT (${expression})::date::text AS d`)).rows[0]?.d ??
  '';
const errorOf = (error: unknown): string =>
  error instanceof Error ? error.message.replace('rule not valid: ', '') : String(error);

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const field = async (body: Record<string, unknown>): Promise<Field> =>
    (await s.owner.browser.post<Field>(`/api/lists/${s.tarefas}/fields`, body)).body;
  supplier = await field({
    name: 'Fornecedor',
    kind: 'select',
    config: { options: [{ name: 'Alfa' }, { name: 'Beta' }] },
  });
  [alfa = '', beta = ''] = supplier.config.options.map((option) => option.id);
  box = (await field({ name: 'Conferido', kind: 'checkbox' })).id;
  note = (await field({ name: 'Observação', kind: 'text' })).id;
  secret = (await field({ name: 'Senha', kind: 'secret' })).id;
  await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
    capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
  });
});
beforeEach(async () => {
  await env.admin.query('DELETE FROM app.automations');
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('saying when and what', () => {
  it('names only fields, values and people that fit, by the API and at the database', async () => {
    const p1 = [{ do: 'priority', to: 1 }];
    const tries: [Record<string, unknown>, string][] = [
      [{ trigger: { on: 'field', field: note, is: 'x' }, actions: p1 }, 'unknown_field'],
      [{ trigger: { on: 'field', field: supplier.id, is: 'outra' }, actions: p1 }, 'unknown_field'],
      [{ trigger: { on: 'assigned', to: s.ana.id, extra: 1 }, actions: p1 }, 'invalid_input'],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'field', field: secret, value: 'x' }] },
        'unknown_field',
      ],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'field', field: supplier.id, value: 'x' }] },
        'invalid_value',
      ],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'field', field: box, value: false }] },
        'invalid_value',
      ],
      [{ trigger: { on: 'created' }, actions: [{ do: 'due', in: 400 }] }, 'invalid_input'],
      [{ trigger: { on: 'created' }, actions: [{ do: 'subtask', title: '  ' }] }, 'invalid_input'],
    ];
    for (const [body, code] of tries) {
      const tried = await save({ name: 'Regra', ...body });
      expect(tried.body.error.code, JSON.stringify(body)).toBe(code);
    }
    const fine = await save({
      name: 'Tudo certo',
      trigger: { on: 'field', field: box, is: true },
      actions: [
        { do: 'field', field: note, value: 'Conferido.' },
        { do: 'field', field: supplier.id, value: null },
        { do: 'due', in: 0 },
        { do: 'subtask', title: 'Arquivar' },
      ],
    });
    expect(fine.status).toBe(200);

    const insert = (trigger: unknown, actions: unknown) =>
      env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', $2, $3, $4)`,
          [s.tarefas, JSON.stringify(trigger), JSON.stringify(actions), s.owner.id],
        )
        .then(() => 'ok', errorOf);
    const other = (
      await s.owner.browser.post<Field>(`/api/lists/${s.perfis}/fields`, {
        name: 'De lá',
        kind: 'checkbox',
      })
    ).body.id;
    expect(await insert({ on: 'field', field: other }, p1)).toBe('unknown_field');
    expect(await insert({ on: 'field', field: note, when: 1 }, p1)).toBe('bad_trigger');
    expect(await insert({ on: 'field', field: box, is: 'sim' }, p1)).toBe('unknown_field');
    expect(await insert({ on: 'assigned', to: 'x' }, p1)).toBe('unknown_person');
    expect(await insert({ on: 'assigned', to: s.ana.id, from: s.bruno.id }, p1)).toBe(
      'bad_trigger',
    );
    expect(await insert({ on: 'created' }, [{ do: 'field', field: note }])).toBe('unknown_field');
    expect(await insert({ on: 'created' }, [{ do: 'field', field: other, value: true }])).toBe(
      'unknown_field',
    );
    expect(await insert({ on: 'created' }, [{ do: 'field', field: note, value: 7 }])).toBe(
      'invalid_value',
    );
    for (const due of [-1, 366, 1.5, '3', true]) {
      expect(await insert({ on: 'created' }, [{ do: 'due', in: due }]), String(due)).toBe(
        'bad_actions',
      );
    }
    expect(await insert({ on: 'created' }, [{ do: 'due' }])).toBe('bad_actions');
    expect(await insert({ on: 'created' }, [{ do: 'subtask', title: 3 }])).toBe('bad_actions');
    expect(await insert({ on: 'created' }, [{ do: 'subtask', title: 'x'.repeat(201) }])).toBe(
      'bad_actions',
    );
    expect(
      await insert({ on: 'assigned' }, [
        { do: 'due', in: null },
        { do: 'due', in: 365 },
        { do: 'field', field: box, value: true },
      ]),
    ).toBe('ok');
    // A field put away no longer counts.
    await s.owner.browser.patch(`/api/fields/${other}`, { archived: true });
  });
});

describe('when a field changes', () => {
  it('acts when it changes to the value named, or at all', async () => {
    const toAlfa = await save({
      name: 'Virou Alfa',
      trigger: { on: 'field', field: supplier.id, is: alfa },
      actions: [{ do: 'priority', to: 1 }],
    });
    const unticked = await save({
      name: 'Desmarcou',
      trigger: { on: 'field', field: box, is: false },
      actions: [{ do: 'priority', to: 4 }],
    });
    const anyNote = await save({
      name: 'Mexeu na observação',
      trigger: { on: 'field', field: note },
      actions: [{ do: 'due', in: 2 }],
    });
    const first = await newItem('Pedido de compra');
    await setFields(first, { [supplier.id]: beta });
    expect((await itemOf(first))?.priority).toBeNull();
    await setFields(first, { [supplier.id]: alfa });
    expect((await itemOf(first))?.priority).toBe(1);
    // The same value again is no change.
    await env.admin.query('UPDATE app.items SET priority = NULL WHERE id = $1', [first]);
    await setFields(first, { [supplier.id]: alfa });
    expect((await itemOf(first))?.priority).toBeNull();
    expect(await runsOf(toAlfa.body.id)).toHaveLength(1);

    const second = await newItem('Conferência');
    await setFields(second, { [box]: true });
    expect((await itemOf(second))?.priority).toBeNull();
    await setFields(second, { [box]: null });
    expect((await itemOf(second))?.priority).toBe(4);
    expect(await runsOf(unticked.body.id)).toHaveLength(1);

    await setFields(second, { [note]: 'Ver amanhã' });
    expect((await itemOf(second))?.dueDate).toBe(await day('current_date + 2'));
    await env.admin.query('UPDATE app.items SET due_date = NULL WHERE id = $1', [second]);
    await setFields(second, { [note]: null });
    expect((await itemOf(second))?.dueDate).toBe(await day('current_date + 2'));
    expect(await runsOf(anyNote.body.id)).toHaveLength(2);
  });

  it('leaves alone what is filled in while the item is being created', async () => {
    const rule = await save({
      name: 'Qualquer Alfa',
      trigger: { on: 'field', field: supplier.id },
      actions: [{ do: 'priority', to: 2 }],
    });
    const id = await newItem('Já nasce Alfa', { fields: { [supplier.id]: alfa } });
    expect((await itemOf(id))?.priority).toBeNull();
    expect(await runsOf(rule.body.id)).toHaveLength(0);
  });
});

describe('when someone is handed the item', () => {
  it('acts for anyone or for the person named, never for whoever creates it', async () => {
    const forAna = await save({
      name: 'Chegou para a Ana',
      trigger: { on: 'assigned', to: s.ana.id },
      actions: [{ do: 'comment', text: 'Ana, veja o prazo.' }],
    });
    const forAnyone = await save({
      name: 'Chegou para alguém',
      trigger: { on: 'assigned' },
      actions: [{ do: 'due', in: 7 }],
    });
    const id = await newItem('Entrega');
    await assign(id, [s.bruno]);
    expect((await itemOf(id))?.dueDate).toBe(await day('current_date + 7'));
    expect(await runsOf(forAna.body.id)).toHaveLength(0);
    await assign(id, [s.bruno, s.ana]);
    const comments = (await s.owner.browser.get<{ body: string }[]>(`/api/items/${id}/comments`))
      .body;
    expect(comments.map((comment) => comment.body)).toEqual(['Ana, veja o prazo.']);
    // Removing someone is not handing over.
    await assign(id, [s.ana]);
    expect(await runsOf(forAnyone.body.id)).toHaveLength(2);

    // Ana creates her own item and is put on it: that is the creation, not a hand-over.
    const hers = (
      await s.ana.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title: 'Dela' })
    ).body.id;
    expect((await itemOf(hers))?.assignees).toEqual([s.ana.id]);
    expect(await runsOf(forAna.body.id)).toHaveLength(1);
  });
});

describe('what the new actions do', () => {
  it('fills in and clears fields, as its author, marked as the rule', async () => {
    const rule = await save({
      name: 'Ao andar',
      trigger: { on: 'stage' },
      actions: [
        { do: 'field', field: note, value: 'Em andamento' },
        { do: 'field', field: box, value: true },
        { do: 'field', field: supplier.id, value: null },
      ],
    });
    const id = await newItem('Campos');
    await setFields(id, { [supplier.id]: beta });
    const stages = (
      await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
    ).body;
    const active = stages.find((one) => one.kind === 'active')?.id ?? '';
    await s.owner.browser.patch(`/api/items/${id}`, { stageId: active });
    expect((await itemOf(id))?.fields).toEqual({ [note]: 'Em andamento', [box]: true });
    const story = await env.admin.query(
      `SELECT field_id, actor, automation_id FROM app.item_changes
       WHERE item_id = $1 AND what = 'field' AND automation_id IS NOT NULL ORDER BY id`,
      [id],
    );
    expect(story.rows).toEqual(
      [note, box, supplier.id].map((field) => ({
        field_id: field,
        actor: s.owner.id,
        automation_id: rule.body.id,
      })),
    );
  });

  it('sets the due date some days ahead, and fails whole when that cannot be', async () => {
    const rule = await save({
      name: 'Prazo em 3 dias',
      trigger: { on: 'assigned' },
      actions: [
        { do: 'priority', to: 2 },
        { do: 'due', in: 3 },
      ],
    });
    const fits = await newItem('Cabe');
    await assign(fits, [s.bruno]);
    expect(await itemOf(fits)).toMatchObject({
      priority: 2,
      dueDate: await day('current_date + 3'),
    });
    // It starts after the new due date: the rule cannot, and changes nothing.
    const late = await newItem('Começa depois');
    await s.owner.browser.patch(`/api/items/${late}`, {
      startDate: await day('current_date + 10'),
    });
    expect((await assign(late, [s.bruno])).status).toBe(200);
    expect(await itemOf(late)).toMatchObject({
      priority: null,
      dueDate: null,
      assignees: [s.bruno.id],
    });
    expect((await runsOf(rule.body.id))[0]).toMatchObject({ outcome: 'failed', detail: '23514' });
  });

  it('adds a subtask by its author, and never under a subtask', async () => {
    const rule = await save(
      {
        name: 'Toda tarefa tem conferência',
        trigger: { on: 'assigned', to: s.ana.id },
        actions: [{ do: 'subtask', title: '  Conferir com o cliente  ' }],
      },
      s.marta,
    );
    expect(rule.status).toBe(200);
    const id = await newItem('Com filha');
    await assign(id, [s.ana]);
    const child = (await items()).find((item) => item.parentId === id);
    expect(child).toMatchObject({ title: 'Conferir com o cliente', createdBy: s.marta.id });

    // Under a subtask there is nothing to hang from: the rule fails, the hand-over stays.
    await assign(child?.id ?? '', [s.ana]);
    expect((await itemOf(child?.id ?? ''))?.assignees).toEqual([s.ana.id]);
    expect((await items()).filter((item) => item.parentId === child?.id)).toHaveLength(0);
    expect((await runsOf(rule.body.id))[0]).toMatchObject({ outcome: 'failed', detail: 'CB003' });
  });

  it('names a subtask without the spaces around it, whoever wrote the rule', async () => {
    await env.admin.query(
      `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
       VALUES (gen_random_uuid(), $1, 'Direta', '{"on":"assigned"}',
               '[{"do":"subtask","title":"  Revisar  "}]', $2)`,
      [s.tarefas, s.owner.id],
    );
    const id = await newItem('Mãe');
    await assign(id, [s.bruno]);
    expect(
      (await items()).filter((item) => item.parentId === id).map((item) => item.title),
    ).toEqual(['Revisar']);
  });

  it('chains through the new triggers, and still stops three levels down', async () => {
    await save({
      name: 'Marcou, anota',
      trigger: { on: 'field', field: box, is: true },
      actions: [{ do: 'field', field: note, value: 'Marcado' }],
    });
    await save({
      name: 'Anotou, desmarca',
      trigger: { on: 'field', field: note },
      actions: [{ do: 'field', field: box, value: null }],
    });
    await save({
      name: 'Desmarcou, marca',
      trigger: { on: 'field', field: box, is: false },
      actions: [{ do: 'field', field: box, value: true }],
    });
    const id = await newItem('Corrente');
    expect((await setFields(id, { [box]: true })).status).toBe(200);
    // Person ticks; rule 1 notes; rule 2 unticks; rule 3 (third level) ticks again; no more.
    expect((await itemOf(id))?.fields).toEqual({ [note]: 'Marcado', [box]: true });
    const runs = await env.admin.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM app.automation_runs WHERE item_id = $1',
      [id],
    );
    expect(runs.rows[0]?.count).toBe(3);
  });

  it('acts on a value checked again when it runs, failing whole if it no longer fits', async () => {
    const rule = await save({
      name: 'Volta para Beta',
      trigger: { on: 'assigned' },
      actions: [
        { do: 'priority', to: 3 },
        { do: 'field', field: supplier.id, value: beta },
      ],
    });
    // Beta is put away after the rule was saved.
    await s.owner.browser.patch(`/api/fields/${supplier.id}`, {
      config: {
        options: supplier.config.options.map((option) => ({
          ...option,
          ...(option.id === beta ? { archived: true } : {}),
        })),
      },
    });
    const id = await newItem('Sem Beta');
    await assign(id, [s.bruno]);
    expect(await itemOf(id)).toMatchObject({ priority: null, assignees: [s.bruno.id] });
    expect((await runsOf(rule.body.id))[0]).toMatchObject({ outcome: 'failed' });
  });

  it('starts nothing for imports, at the database', async () => {
    await save({
      name: 'Qualquer campo',
      trigger: { on: 'field', field: note },
      actions: [{ do: 'priority', to: 1 }],
    });
    const id = await newItem('Antiga');
    await env.admin.query(
      `INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
       VALUES ($1, $2, '"importado"', $3)`,
      [id, note, s.owner.id],
    );
    expect((await itemOf(id))?.priority).toBeNull();
    // The same, by a person, at the database.
    expect(await bind(app, s.owner)).toBe(true);
    await app.query(`UPDATE app.item_field_values SET value = '"mudado"' WHERE item_id = $1`, [id]);
    await app.query('COMMIT');
    expect((await itemOf(id))?.priority).toBe(1);
  });
});
