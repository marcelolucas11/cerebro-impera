import { randomUUID } from 'node:crypto';
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
 * Stages: the groups a list is read by, the stage every item is always in,
 * and the record of how long it stayed in each. First through the API, then
 * straight at the database with the API's own credentials.
 */

interface ErrorBody {
  error: { code: string };
}
interface Stage {
  id: string;
  listId: string;
  name: string;
  color: string;
  kind: string;
  position: number;
}
interface Item {
  id: string;
  stageId: string;
  stageSince: string;
}
interface Stay {
  stageId: string;
  stageName: string;
  enteredAt: string;
  leftAt: string | null;
  movedBy: string | null;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let tarefas: Stage[];
let perfis: Stage[];

const stagesOf = async (person: Person, list: string): Promise<Stage[]> => {
  const response = await person.browser.get<Stage[]>(`/api/lists/${list}/stages`);
  expect(response.status).toBe(200);
  return response.body;
};
const itemsOf = async (person: Person, list: string): Promise<Item[]> =>
  (await person.browser.get<Item[]>(`/api/lists/${list}/items`)).body;
const stage = (stages: Stage[], name: string): Stage => {
  const found = stages.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no stage called ${name}`);
  return found;
};

const REFUSALS = new Set(['42501', 'CB001', 'CB002', 'CB003']);
const refused = (result: Attempt): boolean =>
  result.ok ? result.rowCount === 0 : REFUSALS.has(result.code ?? '');

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  tarefas = await stagesOf(s.owner, s.tarefas);
  perfis = await stagesOf(s.owner, s.perfis);
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('a list', () => {
  it('is born with a starting set of stages, in order', () => {
    expect(tarefas.map((each) => [each.name, each.kind, each.position])).toEqual([
      ['A fazer', 'open', 0],
      ['Fazendo', 'active', 1],
      ['Feito', 'done', 2],
    ]);
    expect(tarefas.every((each) => each.listId === s.tarefas)).toBe(true);
    expect(new Set([...tarefas, ...perfis].map((each) => each.id)).size).toBe(6);
  });

  it('can be created with its own stages instead, such as the life of a client', async () => {
    const created = await s.owner.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      name: 'Clientes',
      stages: [
        { name: 'Entrou', color: '#9BA6B8', kind: 'open' },
        { name: 'Aquecendo', color: '#dba63f', kind: 'active' },
        { name: 'Rodando', color: '#58b98a', kind: 'active' },
        { name: 'Pausado', color: '#ef7b6a', kind: 'active' },
        { name: 'Saiu', color: '#2e394b', kind: 'closed' },
      ],
    });
    expect(created.status).toBe(200);
    const stages = await stagesOf(s.owner, created.body.id);
    expect(stages.map((each) => each.name)).toEqual([
      'Entrou',
      'Aquecendo',
      'Rodando',
      'Pausado',
      'Saiu',
    ]);
    expect(stages[0]?.color).toBe('#9ba6b8');
  });

  it('refuses a set with repeated names, no stages at all, or a made-up kind', async () => {
    const base = { spaceId: s.operacao, name: 'Outra' };
    for (const stages of [
      [],
      [
        { name: 'Ativo', color: '#58b98a', kind: 'active' },
        { name: 'ativo', color: '#58b98a', kind: 'done' },
      ],
      [{ name: 'X', color: 'verde', kind: 'active' }],
      [{ name: 'X', color: '#58b98a', kind: 'quase' }],
      [{ name: '', color: '#58b98a', kind: 'active' }],
    ]) {
      const response = await s.owner.browser.post('/api/lists', { ...base, stages });
      expect(response.status).toBe(400);
    }
  });
});

describe('an item', () => {
  it('starts in the first stage of its list and can move to another stage of that list', async () => {
    const created = await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
      title: 'Subir campanha',
    });
    expect(created.body.stageId).toBe(stage(tarefas, 'A fazer').id);

    const moved = await s.owner.browser.patch<Item>(`/api/items/${created.body.id}`, {
      stageId: stage(tarefas, 'Fazendo').id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.stageId).toBe(stage(tarefas, 'Fazendo').id);
    expect(Date.parse(moved.body.stageSince)).toBeGreaterThanOrEqual(
      Date.parse(created.body.stageSince),
    );

    const direct = await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
      title: 'Já nasce pronta',
      stageId: stage(tarefas, 'Feito').id,
    });
    expect(direct.body.stageId).toBe(stage(tarefas, 'Feito').id);
  });

  it('is assigned to its creator when the creator only sees their own items', async () => {
    const hers = await s.ana.browser.post<Item & { assignees: string[] }>(
      `/api/lists/${s.tarefas}/items`,
      { title: 'Criado pela Ana' },
    );
    expect(hers.body.assignees).toEqual([s.ana.id]);
    // Someone who sees the whole list decides who is responsible; nothing is assumed.
    const owners = await s.owner.browser.post<Item & { assignees: string[] }>(
      `/api/lists/${s.tarefas}/items`,
      { title: 'Criado pelo Dono' },
    );
    expect(owners.body.assignees).toEqual([]);
    // Being responsible for her own item does not let her hand it to someone else.
    const delegate = await s.ana.browser.put(`/api/items/${hers.body.id}/assignees`, {
      userIds: [s.bruno.id],
    });
    expect(delegate.status).toBe(403);
  });

  it('cannot be put in a stage of another list, or in one that does not exist', async () => {
    for (const stageId of [stage(perfis, 'Fazendo').id, randomUUID()]) {
      const moved = await s.owner.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
        stageId,
      });
      expect(moved.status).toBe(400);
      expect(moved.body.error.code).toBe('invalid_stage');
      const created = await s.owner.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/items`, {
        title: 'x',
        stageId,
      });
      expect(created.status).toBe(400);
    }
    const untouched = (await itemsOf(s.owner, s.tarefas)).find((i) => i.id === s.itemNobody);
    expect(untouched?.stageId).toBe(stage(tarefas, 'A fazer').id);
  });

  it('keeps a record of every stage it was in, from when to when, and who moved it', async () => {
    const todo = stage(tarefas, 'A fazer');
    const doing = stage(tarefas, 'Fazendo');
    const done = stage(tarefas, 'Feito');
    await s.ana.browser.patch(`/api/items/${s.itemAna}`, { stageId: doing.id });
    // Changing something else does not count as a move.
    await s.ana.browser.patch(`/api/items/${s.itemAna}`, { description: 'em andamento' });
    await s.ana.browser.patch(`/api/items/${s.itemAna}`, { stageId: doing.id });
    const final = await s.owner.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      stageId: done.id,
    });

    const history = await s.ana.browser.get<Stay[]>(`/api/items/${s.itemAna}/stage-history`);
    expect(history.status).toBe(200);
    expect(history.body.map((stay) => [stay.stageName, stay.stageId])).toEqual([
      ['A fazer', todo.id],
      ['Fazendo', doing.id],
      ['Feito', done.id],
    ]);
    const [first, second, third] = history.body;
    expect(first?.leftAt).toBe(second?.enteredAt);
    expect(second?.leftAt).toBe(third?.enteredAt);
    expect(third?.leftAt).toBeNull();
    expect(second?.movedBy).toBe(s.ana.id);
    expect(third?.movedBy).toBe(s.owner.id);
    expect(third?.enteredAt).toBe(final.body.stageSince);
    for (const stay of history.body) {
      if (stay.leftAt !== null) {
        expect(Date.parse(stay.leftAt)).toBeGreaterThanOrEqual(Date.parse(stay.enteredAt));
      }
    }
  });

  it('shows its history only to whoever can see the item', async () => {
    expect((await s.ana.browser.get(`/api/items/${s.itemBruno}/stage-history`)).status).toBe(404);
    expect((await s.nuno.browser.get(`/api/items/${s.itemAna}/stage-history`)).status).toBe(404);
    expect((await s.ana.browser.get(`/api/items/${randomUUID()}/stage-history`)).status).toBe(404);
    expect((await s.bruno.browser.get(`/api/items/${s.itemBruno}/stage-history`)).status).toBe(200);
  });
});

describe('the stages of a list', () => {
  it('are visible to whoever can open the list, and to nobody else', async () => {
    expect((await stagesOf(s.ana, s.tarefas)).map((each) => each.name)).toEqual([
      'A fazer',
      'Fazendo',
      'Feito',
    ]);
    for (const list of [s.perfis, s.dinheiro, randomUUID()]) {
      expect((await s.ana.browser.get(`/api/lists/${list}/stages`)).status).toBe(404);
    }
    expect((await s.nuno.browser.get(`/api/lists/${s.tarefas}/stages`)).status).toBe(404);
  });

  it('follow the same rule as the items of a sensitive list', async () => {
    await expireStepUp(env, s.owner);
    const closed = await s.owner.browser.get<ErrorBody>(`/api/lists/${s.dinheiro}/stages`);
    expect(closed.status).toBe(403);
    expect(closed.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect((await stagesOf(s.owner, s.dinheiro)).length).toBe(3);
  });

  it('are changed only by whoever manages the list', async () => {
    const doing = stage(tarefas, 'Fazendo');
    // Ana edits items in this list; that does not make the stages hers to change.
    const b = s.ana.browser;
    expect((await b.post(`/api/lists/${s.tarefas}/stages`, { name: 'Minha etapa' })).status).toBe(
      403,
    );
    expect((await b.patch(`/api/stages/${doing.id}`, { name: 'Outra' })).status).toBe(403);
    expect((await b.delete(`/api/stages/${doing.id}`)).status).toBe(403);
    expect(
      (await b.put(`/api/lists/${s.tarefas}/stages/order`, { ids: tarefas.map((x) => x.id) }))
        .status,
    ).toBe(403);
    // Nuno cannot open the list at all: for him none of this exists.
    const n = s.nuno.browser;
    expect((await n.post(`/api/lists/${s.tarefas}/stages`, { name: 'Etapa' })).status).toBe(404);
    expect((await n.patch(`/api/stages/${doing.id}`, { name: 'Outra' })).status).toBe(404);
    expect((await n.delete(`/api/stages/${doing.id}`)).status).toBe(404);
    // And Ana cannot reach the stages of a list she does not see.
    expect(
      (await b.patch(`/api/stages/${stage(perfis, 'Fazendo').id}`, { name: 'Outra' })).status,
    ).toBe(404);

    expect((await stagesOf(s.owner, s.tarefas)).map((each) => each.name)).toEqual([
      'A fazer',
      'Fazendo',
      'Feito',
    ]);
  });

  it('can be added, renamed, recolored and reordered by a manager of the list', async () => {
    const added = await s.marta.browser.post<Stage>(`/api/lists/${s.perfis}/stages`, {
      name: 'Bloqueado',
      color: '#EF7B6A',
      kind: 'closed',
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: 'Bloqueado', color: '#ef7b6a', position: 3 });

    const renamed = await s.marta.browser.patch<Stage>(`/api/stages/${added.body.id}`, {
      name: 'Bloqueados',
    });
    expect(renamed.body.name).toBe('Bloqueados');

    const order = [added.body.id, ...perfis.map((each) => each.id)];
    const reordered = await s.marta.browser.put<Stage[]>(`/api/lists/${s.perfis}/stages/order`, {
      ids: order,
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.map((each) => each.id)).toEqual(order);
    expect((await stagesOf(s.owner, s.perfis)).map((each) => each.name)).toEqual([
      'Bloqueados',
      'A fazer',
      'Fazendo',
      'Feito',
    ]);

    // The order must name exactly the stages of this list: no more, no fewer, none foreign.
    for (const ids of [
      order.slice(1),
      [...order, randomUUID()],
      [order[0], order[0], order[1], order[2]],
      [stage(tarefas, 'Feito').id, ...order.slice(1)],
    ]) {
      const bad = await s.marta.browser.put(`/api/lists/${s.perfis}/stages/order`, { ids });
      expect(bad.status).toBe(400);
    }
  });

  it('have unique names within a list, whatever the capitalisation', async () => {
    const repeated = await s.owner.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/stages`, {
      name: 'FEITO',
    });
    expect(repeated.status).toBe(409);
    const renamed = await s.owner.browser.patch<ErrorBody>(
      `/api/stages/${stage(tarefas, 'Fazendo').id}`,
      { name: 'feito' },
    );
    expect(renamed.status).toBe(409);
    // The same name in another list is fine.
    expect(stage(perfis, 'Feito').name).toBe('Feito');
  });

  it('leave a trace when they change', async () => {
    const trail =
      await s.owner.browser.get<{ action: string; actorUserId: string | null }[]>(
        '/api/audit?limit=200',
      );
    const actions = trail.body.map((entry) => entry.action);
    expect(actions).toContain('list_stages.insert');
    expect(actions).toContain('list_stages.update');
    expect(
      trail.body.some(
        (entry) => entry.action === 'list_stages.update' && entry.actorUserId === s.marta.id,
      ),
    ).toBe(true);
  });
});

describe('removing a stage', () => {
  it('is refused while items are still in it, until they are given another stage', async () => {
    const todo = stage(tarefas, 'A fazer');
    const doing = stage(tarefas, 'Fazendo');
    const before = (await itemsOf(s.owner, s.tarefas)).filter((i) => i.stageId === todo.id);
    expect(before.length).toBeGreaterThan(0);

    const refusedNow = await s.owner.browser.delete<ErrorBody>(`/api/stages/${todo.id}`);
    expect(refusedNow.status).toBe(409);
    expect(refusedNow.body.error.code).toBe('stage_in_use');

    // The destination must be another stage of the same list.
    for (const moveTo of [todo.id, stage(perfis, 'Feito').id, randomUUID()]) {
      const bad = await s.owner.browser.delete(`/api/stages/${todo.id}`, { moveTo });
      expect(bad.status).toBe(400);
    }
    expect((await stagesOf(s.owner, s.tarefas)).some((each) => each.id === todo.id)).toBe(true);

    const removed = await s.owner.browser.delete<{ moved: number }>(`/api/stages/${todo.id}`, {
      moveTo: doing.id,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.moved).toBe(before.length);
    const after = await itemsOf(s.owner, s.tarefas);
    expect(after.every((i) => i.stageId !== todo.id)).toBe(true);
    expect((await stagesOf(s.owner, s.tarefas)).map((each) => each.name)).toEqual([
      'Fazendo',
      'Feito',
    ]);

    // What the moved items went through is still readable, with the removed stage by name.
    const history = await s.owner.browser.get<Stay[]>(`/api/items/${s.itemNobody}/stage-history`);
    expect(history.body.map((stay) => stay.stageName)).toEqual(['A fazer', 'Fazendo']);
  });

  it('never leaves a list without any stage', async () => {
    const list = await s.owner.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      name: 'Curta',
      stages: [
        { name: 'Única', color: '#9ba6b8', kind: 'open' },
        { name: 'Outra', color: '#58b98a', kind: 'done' },
      ],
    });
    const [first, second] = await stagesOf(s.owner, list.body.id);
    expect((await s.owner.browser.delete(`/api/stages/${first?.id}`)).status).toBe(200);
    const last = await s.owner.browser.delete<ErrorBody>(`/api/stages/${second?.id}`);
    expect(last.status).toBe(409);
    expect(last.body.error.code).toBe('rule_violation');
    expect(await stagesOf(s.owner, list.body.id)).toHaveLength(1);
  });

  it('does not happen under an item its remover cannot see', async () => {
    // Bruno manages this list but only sees his own items.
    const list = await s.owner.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      name: 'Compartilhada',
    });
    const granted = await s.owner.browser.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: list.body.id,
      level: 'manage',
      itemScope: 'assigned',
    });
    expect(granted.status).toBe(200);
    const stages = await stagesOf(s.owner, list.body.id);
    const hidden = await s.owner.browser.post<Item>(`/api/lists/${list.body.id}/items`, {
      title: 'Do Dono',
    });
    const mine = await s.bruno.browser.post<Item>(`/api/lists/${list.body.id}/items`, {
      title: 'Do Bruno',
    });
    expect((await itemsOf(s.bruno, list.body.id)).map((i) => i.id)).toEqual([mine.body.id]);

    const attemptToRemove = await s.bruno.browser.delete<ErrorBody>(
      `/api/stages/${stages[0]?.id}`,
      { moveTo: stages[1]?.id },
    );
    expect(attemptToRemove.status).toBe(409);
    expect(attemptToRemove.body.error.code).toBe('stage_in_use');
    // Nothing happened by halves: his own item was not moved either.
    const all = await itemsOf(s.owner, list.body.id);
    expect(all.find((i) => i.id === mine.body.id)?.stageId).toBe(stages[0]?.id);
    expect(all.find((i) => i.id === hidden.body.id)?.stageId).toBe(stages[0]?.id);
    expect(await stagesOf(s.owner, list.body.id)).toHaveLength(3);
  });
});

describe('straight at the database', () => {
  it('an employee cannot change stages, rewrite history or backdate a move', async () => {
    const doing = (await stagesOf(s.owner, s.tarefas))[0];
    expect(await bind(app, s.ana)).toBe(true);
    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.list_stages (id, list_id, name) VALUES (gen_random_uuid(), $1, 'minha')`,
        [s.tarefas],
      ],
      [`UPDATE app.list_stages SET name = 'invadida'`, []],
      [`DELETE FROM app.list_stages`, []],
      [`UPDATE app.items SET stage_since = '2000-01-01' WHERE id = $1`, [s.itemAna]],
      [`UPDATE app.item_stage_history SET entered_at = '2000-01-01'`, []],
      [`DELETE FROM app.item_stage_history`, []],
      [
        `INSERT INTO app.item_stage_history (item_id, stage_id, stage_name)
         VALUES ($1, $2, 'forjada')`,
        [s.itemAna, doing?.id],
      ],
      [`TRUNCATE app.item_stage_history`, []],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }

    // A stage of another list is not an option, even for an item she may edit.
    const foreign = await attempt(app, 'UPDATE app.items SET stage_id = $1 WHERE id = $2', [
      stage(perfis, 'Feito').id,
      s.itemAna,
    ]);
    expect(foreign).toMatchObject({ ok: false, code: '23503' });

    // She reads the history of her own items and of no other.
    const history = await app.query<{ item_id: string }>(
      'SELECT DISTINCT item_id FROM app.item_stage_history',
    );
    const hers = await app.query<{ id: string }>('SELECT id FROM app.items');
    const seen = history.rows.map((row) => row.item_id).sort();
    expect(seen).toEqual(hers.rows.map((row) => row.id).sort());
    expect(seen).toContain(s.itemAna);
    expect(seen).not.toContain(s.itemBruno);
    expect(seen).not.toContain(s.itemNobody);
    expect(
      (
        await env.admin.query('SELECT 1 FROM app.item_stage_history WHERE item_id = $1', [
          s.itemBruno,
        ])
      ).rowCount,
    ).toBeGreaterThan(0);
    const visible = await app.query<{ list_id: string }>(
      'SELECT DISTINCT list_id FROM app.list_stages',
    );
    expect(visible.rows.map((row) => row.list_id)).toEqual([s.tarefas]);
    // An item she creates with plain SQL is hers from birth, and recorded as such by herself.
    const own = randomUUID();
    await app.query('INSERT INTO app.items (id, list_id, title) VALUES ($1, $2, $3)', [
      own,
      s.tarefas,
      'direto',
    ]);
    const assigned = await app.query<{ user_id: string; assigned_by: string }>(
      'SELECT user_id, assigned_by FROM app.item_assignees WHERE item_id = $1',
      [own],
    );
    expect(assigned.rows).toEqual([{ user_id: s.ana.id, assigned_by: s.ana.id }]);
    expect(
      refused(
        await attempt(app, 'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)', [
          own,
          s.bruno.id,
        ]),
      ),
    ).toBe(true);

    // Whether a stage she cannot manage still holds items is not hers to know.
    const probe = await app.query<{ in_use: boolean }>('SELECT app.stage_in_use($1) AS in_use', [
      doing?.id,
    ]);
    expect(probe.rows[0]?.in_use).toBe(false);
    await app.query('ROLLBACK');
  });

  it('a manager changes the stages of their own lists and of no other', async () => {
    expect(await bind(app, s.marta)).toBe(true);
    const allowed = await attempt(
      app,
      `INSERT INTO app.list_stages (id, list_id, name) VALUES (gen_random_uuid(), $1, 'Nova')`,
      [s.tarefas],
    );
    expect(allowed).toMatchObject({ ok: true, rowCount: 1 });
    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.list_stages (id, list_id, name) VALUES (gen_random_uuid(), $1, 'Nova')`,
        [s.dinheiro],
      ],
      [`UPDATE app.list_stages SET list_id = $1`, [s.dinheiro]],
      [`UPDATE app.list_stages SET created_by = $1`, [s.owner.id]],
    ];
    for (const [text, values] of statements) {
      expect(refused(await attempt(app, text, values)), text).toBe(true);
    }
    expect(
      (await app.query('SELECT 1 FROM app.list_stages WHERE list_id = $1', [s.dinheiro])).rowCount,
    ).toBe(0);
    await app.query('ROLLBACK');
  });

  it('the history writes itself, whoever moves the item and however', async () => {
    const stages = await stagesOf(s.owner, s.tarefas);
    const [from, to] = [stages[0], stages[1]];
    const id = randomUUID();
    expect(await bind(app, s.owner)).toBe(true);
    // Plain SQL, no API involved.
    await app.query('INSERT INTO app.items (id, list_id, title) VALUES ($1, $2, $3)', [
      id,
      s.tarefas,
      'Direto no banco',
    ]);
    await app.query('UPDATE app.items SET stage_id = $1 WHERE id = $2', [to?.id, id]);
    await app.query(`UPDATE app.items SET title = 'renomeado' WHERE id = $1`, [id]);
    const history = await app.query<{ stage_id: string; open: boolean; moved_by: string }>(
      `SELECT stage_id, left_at IS NULL AS open, moved_by
       FROM app.item_stage_history WHERE item_id = $1 ORDER BY id`,
      [id],
    );
    expect(history.rows).toEqual([
      { stage_id: from?.id, open: false, moved_by: s.owner.id },
      { stage_id: to?.id, open: true, moved_by: s.owner.id },
    ]);

    // Moved to another list without a stage chosen there: it lands on that list's first.
    await app.query('UPDATE app.items SET list_id = $1 WHERE id = $2', [s.perfis, id]);
    const moved = await app.query<{ stage_id: string; list_id: string }>(
      `SELECT i.stage_id, s.list_id FROM app.items i
       JOIN app.list_stages s ON s.id = i.stage_id WHERE i.id = $1`,
      [id],
    );
    expect(moved.rows[0]?.list_id).toBe(s.perfis);
    const first = await app.query<{ id: string }>(
      'SELECT id FROM app.list_stages WHERE list_id = $1 ORDER BY position LIMIT 1',
      [s.perfis],
    );
    expect(moved.rows[0]?.stage_id).toBe(first.rows[0]?.id);
    expect(
      (
        await app.query(
          'SELECT 1 FROM app.item_stage_history WHERE item_id = $1 AND left_at IS NULL',
          [id],
        )
      ).rowCount,
    ).toBe(1);
    await app.query('ROLLBACK');
  });

  it('the last stage of a list cannot be removed, even by an owner with plain SQL', async () => {
    expect(await bind(app, s.owner)).toBe(true);
    const removed = await attempt(app, 'DELETE FROM app.list_stages WHERE list_id = $1', [
      s.dinheiro,
    ]);
    // The list has an item, so the stages in use cannot go; and never the last one.
    expect(removed.ok).toBe(false);
    await app.query('ROLLBACK');

    expect(await bind(app, s.owner)).toBe(true);
    const empty = randomUUID();
    await app.query(`INSERT INTO app.lists (id, space_id, name) VALUES ($1, $2, 'Vazia')`, [
      empty,
      s.operacao,
    ]);
    await app.query(
      `INSERT INTO app.list_stages (id, list_id, name) VALUES (gen_random_uuid(), $1, 'Só esta')`,
      [empty],
    );
    const last = await attempt(app, 'DELETE FROM app.list_stages WHERE list_id = $1', [empty]);
    expect(last).toMatchObject({ ok: false, code: 'CB003' });
    // And a list with no stage at all cannot receive items.
    const bare = randomUUID();
    await app.query(`INSERT INTO app.lists (id, space_id, name) VALUES ($1, $2, 'Sem etapas')`, [
      bare,
      s.operacao,
    ]);
    const orphan = await attempt(
      app,
      `INSERT INTO app.items (id, list_id, title) VALUES (gen_random_uuid(), $1, 'x')`,
      [bare],
    );
    expect(orphan).toMatchObject({ ok: false, code: 'CB003' });
    await app.query('ROLLBACK');
  });
});
