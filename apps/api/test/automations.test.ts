import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Rules of a list: seen by its managers, written by managers who hold the
 * "automations" capability, and acting with the access of whoever saved them
 * last, never more. A rule never blocks what the person did; what it did is
 * marked as its own. By the API and at the database.
 */

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  runAs: string;
  trigger: Record<string, unknown>;
  conditions: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  lastRun: { outcome: string } | null;
}
interface Run {
  outcome: string;
  detail: string | null;
  itemId: string | null;
  itemTitle: string | null;
}
interface Item {
  id: string;
  stageId: string;
  priority: number | null;
  assignees: string[];
}
interface Comment {
  id: string;
  authorId: string;
  body: string;
  automation: { id: string; name: string | null } | null;
  canEdit: boolean;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stage: { open: string; active: string; done: string };
let otherStage: string;
let supplier: { id: string; config: { options: { id: string; name: string }[] } };

const rules: string[] = [];
const save = async (person: Person, body: Record<string, unknown>, list = s.tarefas) => {
  const saved = await person.browser.post<Rule & ErrorBody>(`/api/lists/${list}/automations`, body);
  if (saved.status === 200) rules.push(saved.body.id);
  return saved;
};
/** Rules from one test do not act in the next. */
const clearRules = async (): Promise<void> => {
  await env.admin.query('DELETE FROM app.automations');
  rules.length = 0;
};
const itemOf = async (id: string): Promise<Item | undefined> =>
  (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
    (item) => item.id === id,
  );
const newItem = async (title: string, person: Person = s.owner): Promise<string> =>
  (await person.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })).body.id;
const moveTo = (person: Person, itemId: string, stageId: string) =>
  person.browser.patch<Item & ErrorBody>(`/api/items/${itemId}`, { stageId });
const runsOf = async (ruleId: string, person: Person = s.owner): Promise<Run[]> =>
  (await person.browser.get<Run[]>(`/api/automations/${ruleId}/runs`)).body;
const codeOf = (error: unknown): string => (error as { code?: string }).code ?? 'none';
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const commentsOf = async (itemId: string): Promise<Comment[]> =>
  (await s.owner.browser.get<Comment[]>(`/api/items/${itemId}/comments`)).body;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const stages = (
    await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
  const of = (kind: string): string => stages.find((one) => one.kind === kind)?.id ?? '';
  stage = { open: of('open'), active: of('active'), done: of('done') };
  otherStage =
    (await s.owner.browser.get<{ id: string }[]>(`/api/lists/${s.perfis}/stages`)).body[0]?.id ??
    '';
  supplier = (
    await s.owner.browser.post<typeof supplier>(`/api/lists/${s.tarefas}/fields`, {
      name: 'Fornecedor',
      kind: 'select',
      config: { options: [{ name: 'Alfa' }, { name: 'Beta' }] },
    })
  ).body;
});
beforeEach(clearRules);
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('writing rules', () => {
  it('is for managers of the list who hold the capability; others are told no', async () => {
    const rule = {
      name: 'Urgente ao criar',
      trigger: { on: 'created' },
      actions: [{ do: 'priority', to: 1 }],
    };
    // Marta manages the list, but has not been given automations.
    expect((await s.marta.browser.get<Rule[]>(`/api/lists/${s.tarefas}/automations`)).status).toBe(
      200,
    );
    expect((await save(s.marta, rule)).status).toBe(403);
    expect((await s.ana.browser.get(`/api/lists/${s.tarefas}/automations`)).status).toBe(403);
    expect((await s.nuno.browser.get(`/api/lists/${s.tarefas}/automations`)).status).toBe(404);
    expect((await save(s.ana, rule)).status).toBe(403);

    const saved = await save(s.owner, rule);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ enabled: true, runAs: s.owner.id, conditions: [] });

    await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
    });
    // Saving a rule makes it act as whoever saved it.
    const paused = await s.marta.browser.patch<Rule>(`/api/automations/${saved.body.id}`, {
      enabled: false,
    });
    expect(paused.body).toMatchObject({ enabled: false, runAs: s.marta.id, name: rule.name });
    expect(
      (await s.ana.browser.patch(`/api/automations/${saved.body.id}`, { enabled: true })).status,
    ).toBe(404);
    const audit = await env.admin.query<{ action: string; actor: string }>(
      `SELECT action, actor_user_id AS actor FROM audit.log
       WHERE target_id = $1 ORDER BY seq`,
      [saved.body.id],
    );
    expect(audit.rows).toEqual([
      { action: 'automations.created', actor: s.owner.id },
      { action: 'automations.updated', actor: s.marta.id },
    ]);
    expect((await s.marta.browser.delete(`/api/automations/${saved.body.id}`)).status).toBe(200);
    expect((await s.marta.browser.get<Rule[]>(`/api/lists/${s.tarefas}/automations`)).body).toEqual(
      [],
    );
    await clearRules();
  });

  it('only names stages, fields and people of its own list', async () => {
    const tries: [Record<string, unknown>, number, string][] = [
      [
        { trigger: { on: 'stage', to: otherStage }, actions: [{ do: 'priority', to: 1 }] },
        400,
        'unknown_stage',
      ],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'stage', to: otherStage }] },
        400,
        'unknown_stage',
      ],
      [
        {
          trigger: { on: 'created' },
          conditions: [{ if: 'field', field: supplier.id, is: 'not-an-option' }],
          actions: [{ do: 'priority', to: 1 }],
        },
        400,
        'unknown_field',
      ],
      [
        {
          trigger: { on: 'created' },
          conditions: [{ if: 'field', field: supplier.id, is: true }],
          actions: [{ do: 'priority', to: 1 }],
        },
        400,
        'unknown_field',
      ],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'assign', to: s.nuno.id }] },
        400,
        'cannot_assign_person',
      ],
      [
        { trigger: { on: 'created' }, actions: [{ do: 'notify', to: [s.nuno.id] }] },
        400,
        'cannot_notify_person',
      ],
      [{ trigger: { on: 'created' }, actions: [] }, 400, 'invalid_input'],
      [
        { trigger: { on: 'created', to: stage.done }, actions: [{ do: 'priority', to: 1 }] },
        400,
        'invalid_input',
      ],
      [{ trigger: { on: 'created' }, actions: [{ do: 'priority', to: 5 }] }, 400, 'invalid_input'],
      [{ trigger: { on: 'created' }, actions: [{ do: 'delete' }] }, 400, 'invalid_input'],
    ];
    for (const [body, status, code] of tries) {
      const tried = await save(s.owner, { name: 'Regra', ...body });
      expect(tried.status, JSON.stringify(body)).toBe(status);
      expect(tried.body.error.code, JSON.stringify(body)).toBe(code);
    }
    const option = supplier.config.options[0]?.id ?? '';
    const fine = await save(s.owner, {
      name: 'Alfa vai para a Ana',
      trigger: { on: 'stage', to: stage.active, from: stage.open },
      conditions: [
        { if: 'field', field: supplier.id, is: option },
        { if: 'priority', is: null },
        { if: 'assignee', is: null },
        { if: 'stage', is: stage.active },
      ],
      actions: [
        { do: 'assign', to: s.ana.id },
        { do: 'notify', to: [s.ana.id, s.marta.id] },
        { do: 'comment', text: '  Pegue esta.  ' },
      ],
    });
    expect(fine.status).toBe(200);
    // Who a rule may hand work to: people who work in the list; anyone who sees it may be told.
    const audience = (
      await s.owner.browser.get<{ id: string; canWork: boolean }[]>(
        `/api/lists/${s.tarefas}/automation-audience`,
      )
    ).body;
    expect(audience.find((one) => one.id === s.ana.id)?.canWork).toBe(true);
    expect(audience.some((one) => one.id === s.nuno.id)).toBe(false);
    expect((await s.ana.browser.get(`/api/lists/${s.tarefas}/automation-audience`)).status).toBe(
      403,
    );
    await clearRules();
  });
});

describe('a rule acting', () => {
  it("acts on a new item with the author's access, and marks what it did as its own", async () => {
    const rule = await save(s.owner, {
      name: 'Toda tarefa nova',
      trigger: { on: 'created' },
      // Whoever sees only their own items is put on what they create.
      conditions: [{ if: 'assignee', is: s.ana.id }],
      actions: [
        { do: 'priority', to: 2 },
        { do: 'comment', text: 'Defina um responsável.' },
        { do: 'notify', to: [s.ana.id, s.marta.id] },
      ],
    });
    const id = await newItem('Pedido novo', s.ana);
    expect(await itemOf(id)).toMatchObject({ priority: 2 });

    const comments = await commentsOf(id);
    expect(comments).toEqual([
      expect.objectContaining({
        authorId: s.owner.id,
        body: 'Defina um responsável.',
        automation: { id: rule.body.id, name: 'Toda tarefa nova' },
        canEdit: false,
      }),
    ]);
    // Nobody rewrites what a rule wrote, its author included.
    const rewrite = await s.owner.browser.patch<ErrorBody>(
      `/api/comments/${comments[0]?.id ?? ''}`,
      { body: 'Outra coisa' },
    );
    expect(rewrite.status).toBe(409);
    expect((await s.owner.browser.delete(`/api/comments/${comments[0]?.id ?? ''}`)).status).toBe(
      200,
    );

    const story = await env.admin.query(
      `SELECT what, actor, automation_id FROM app.item_changes
       WHERE item_id = $1 AND what = 'priority'`,
      [id],
    );
    expect(story.rows).toEqual([
      { what: 'priority', actor: s.owner.id, automation_id: rule.body.id },
    ]);
    const history = (
      await s.owner.browser.get<{ what: string; automation: unknown }[]>(`/api/items/${id}/history`)
    ).body;
    expect(history.find((line) => line.what === 'priority')?.automation).toEqual({
      id: rule.body.id,
      name: 'Toda tarefa nova',
    });
    expect(history.find((line) => line.what === 'created')?.automation).toBeNull();

    // Ana set it off, so she is not told; Marta is, with the rule named.
    const told = await env.admin.query(
      `SELECT user_id, kind, actor, automation_id FROM app.notifications
       WHERE item_id = $1 AND kind = 'automation'`,
      [id],
    );
    expect(told.rows).toEqual([
      { user_id: s.marta.id, kind: 'automation', actor: s.owner.id, automation_id: rule.body.id },
    ]);
    // Which rule caused it does not change, even for the database owner.
    const forged = await env.admin
      .query(
        `UPDATE app.notifications SET automation_id = gen_random_uuid()
         WHERE item_id = $1 AND kind = 'automation'`,
        [id],
      )
      .then(
        () => 'ok',
        (error: unknown) => codeOf(error),
      );
    expect(forged).toBe('CB003');
    const notices = (
      await s.marta.browser.get<{ itemId: string; kind: string; automation: unknown }[]>(
        '/api/notifications',
      )
    ).body;
    expect(notices.find((notice) => notice.itemId === id)).toMatchObject({
      kind: 'automation',
      automation: { id: rule.body.id, name: 'Toda tarefa nova' },
    });

    const runs = await runsOf(rule.body.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(
      expect.objectContaining({
        outcome: 'done',
        detail: null,
        itemId: id,
        itemTitle: 'Pedido novo',
      }),
    );
    // An item that does not fit the rule is left alone, and not logged.
    const other = await newItem('De ninguém');
    expect(await itemOf(other)).toMatchObject({ priority: null, assignees: [] });
    expect(await runsOf(rule.body.id)).toHaveLength(1);
    await clearRules();
  });

  it('sees a new item as the request left it, people and fields included', async () => {
    const option = supplier.config.options[1]?.id ?? '';
    await save(s.owner, {
      name: 'Beta da Ana',
      trigger: { on: 'created' },
      conditions: [
        { if: 'assignee', is: s.ana.id },
        { if: 'field', field: supplier.id, is: option },
      ],
      actions: [{ do: 'priority', to: 1 }],
    });
    expect(await bind(app, s.owner)).toBe(true);
    const created = await app.query<{ id: string }>(
      `INSERT INTO app.items (id, list_id, title) VALUES (gen_random_uuid(), $1, 'Feita aos poucos')
       RETURNING id`,
      [s.tarefas],
    );
    const id = created.rows[0]?.id ?? '';
    await app.query('INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)', [
      id,
      s.ana.id,
    ]);
    await app.query(
      'INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3)',
      [id, supplier.id, JSON.stringify(option)],
    );
    await app.query('COMMIT');
    expect(await itemOf(id)).toMatchObject({ priority: 1 });
    await clearRules();
  });

  it('follows the stage it is given, from where, and its conditions', async () => {
    await save(s.owner, {
      name: 'Aberta para andamento',
      trigger: { on: 'stage', from: stage.open, to: stage.active },
      conditions: [{ if: 'priority', is: null }],
      actions: [{ do: 'priority', to: 3 }],
    });
    const plain = await newItem('Sem pressa');
    const urgent = await newItem('Com pressa');
    await s.owner.browser.patch(`/api/items/${urgent}`, { priority: 1 });
    await moveTo(s.owner, plain, stage.active);
    await moveTo(s.owner, urgent, stage.active);
    expect((await itemOf(plain))?.priority).toBe(3);
    expect((await itemOf(urgent))?.priority).toBe(1);

    // Into the same stage from elsewhere: not this rule.
    const other = await newItem('Pela outra porta');
    await moveTo(s.owner, other, stage.done);
    await moveTo(s.owner, other, stage.active);
    expect((await itemOf(other))?.priority).toBeNull();
    await clearRules();
  });

  it('ticks off an unticked box and a box never ticked alike', async () => {
    const box = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/fields`, {
        name: 'Conferido',
        kind: 'checkbox',
      })
    ).body.id;
    await save(s.owner, {
      name: 'Pronto sem conferir',
      trigger: { on: 'stage', to: stage.done },
      conditions: [{ if: 'field', field: box, is: false }],
      actions: [{ do: 'stage', to: stage.active }],
    });
    const never = await newItem('Nunca conferido');
    const unticked = await newItem('Desmarcado');
    const ticked = await newItem('Conferido');
    await s.owner.browser.patch(`/api/items/${unticked}`, { fields: { [box]: false } });
    await s.owner.browser.patch(`/api/items/${ticked}`, { fields: { [box]: true } });
    for (const id of [never, unticked, ticked]) await moveTo(s.owner, id, stage.done);
    expect((await itemOf(never))?.stageId).toBe(stage.active);
    expect((await itemOf(unticked))?.stageId).toBe(stage.active);
    expect((await itemOf(ticked))?.stageId).toBe(stage.done);
    await clearRules();
  });

  it('never does what its author could not, and never blocks the person', async () => {
    // Marta saves it, then loses her access to the list.
    const rule = await save(s.marta, {
      name: 'Feito vira urgente',
      trigger: { on: 'stage', to: stage.done },
      actions: [{ do: 'priority', to: 1 }],
    });
    expect(rule.status).toBe(200);
    const id = await newItem('Depois da Marta');
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1', [s.marta.id]);
    expect((await moveTo(s.owner, id, stage.done)).status).toBe(200);
    expect(await itemOf(id)).toMatchObject({ stageId: stage.done, priority: null });
    expect((await runsOf(rule.body.id))[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'no_access',
    });
    await s.owner.browser.put('/api/grants', {
      userId: s.marta.id,
      scopeType: 'space',
      scopeId: s.operacao,
      level: 'manage',
    });
    // Nor on a list that needs a recent second factor: a rule never has one.
    await env.admin.query('UPDATE app.lists SET is_sensitive = true WHERE id = $1', [s.tarefas]);
    expect((await moveTo(s.owner, id, stage.active)).status).toBe(200);
    expect((await moveTo(s.owner, id, stage.done)).status).toBe(200);
    expect((await runsOf(rule.body.id))[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'no_access',
    });
    await env.admin.query('UPDATE app.lists SET is_sensitive = false WHERE id = $1', [s.tarefas]);
    await clearRules();
  });

  it('undoes all of a failed rule and logs why, keeping what the person did', async () => {
    const rule = await save(s.owner, {
      name: 'Feito vai para o Bruno',
      trigger: { on: 'stage', to: stage.done },
      actions: [
        { do: 'priority', to: 4 },
        { do: 'assign', to: s.bruno.id },
      ],
    });
    // Bruno no longer works in the list: handing him the item now fails.
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2', [
      s.bruno.id,
      s.tarefas,
    ]);
    const id = await newItem('Sem o Bruno');
    expect((await moveTo(s.owner, id, stage.done)).status).toBe(200);
    expect(await itemOf(id)).toMatchObject({ stageId: stage.done, priority: null, assignees: [] });
    expect((await runsOf(rule.body.id))[0]).toMatchObject({ outcome: 'failed', detail: 'CB003' });
    await s.owner.browser.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'edit',
    });
    await clearRules();
  });

  it('stops rules starting each other three levels down', async () => {
    await save(s.owner, {
      name: 'Ida',
      trigger: { on: 'stage', to: stage.active },
      actions: [{ do: 'stage', to: stage.done }],
    });
    await save(s.owner, {
      name: 'Volta',
      trigger: { on: 'stage', to: stage.done },
      actions: [{ do: 'stage', to: stage.active }],
    });
    const id = await newItem('Pingue-pongue');
    expect((await moveTo(s.owner, id, stage.active)).status).toBe(200);
    // Person → active; Ida → done; Volta → active; Ida (third level) → done; no more.
    expect((await itemOf(id))?.stageId).toBe(stage.done);
    const done = await env.admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM app.automation_runs WHERE item_id = $1`,
      [id],
    );
    expect(done.rows[0]?.count).toBe(3);
    await clearRules();
  });

  it('acts only when every condition holds, and only on its own kind of change', async () => {
    const [alfa, beta] = supplier.config.options.map((option) => option.id);
    const onCreate = await save(s.owner, {
      name: 'Nova já feita, sem dono',
      trigger: { on: 'created' },
      conditions: [
        { if: 'stage', is: stage.done },
        { if: 'assignee', is: null },
      ],
      actions: [{ do: 'priority', to: 1 }],
    });
    const onStage = await save(s.owner, {
      name: 'Alfa da Ana andando',
      trigger: { on: 'stage', to: stage.active },
      conditions: [
        { if: 'assignee', is: s.ana.id },
        { if: 'field', field: supplier.id, is: alfa },
      ],
      actions: [{ do: 'priority', to: 2 }],
    });
    const createIn = async (person: Person, title: string, stageId: string): Promise<string> =>
      (
        await person.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
          title,
          stageId,
        })
      ).body.id;
    const open = await newItem('Aberta');
    const done = await createIn(s.owner, 'Já feita', stage.done);
    // Ana's own: she is put on it, so someone is responsible.
    const hers = await createIn(s.ana, 'Feita pela Ana', stage.done);
    expect((await itemOf(open))?.priority).toBeNull();
    expect((await itemOf(done))?.priority).toBe(1);
    expect((await itemOf(hers))?.priority).toBeNull();
    // Reaching the stage later is not being created there.
    await moveTo(s.owner, open, stage.done);
    expect((await itemOf(open))?.priority).toBeNull();
    expect(await runsOf(onCreate.body.id)).toHaveLength(1);

    const made = async (title: string, person: Person, option: string | undefined) => {
      const id = await newItem(title);
      await s.owner.browser.put(`/api/items/${id}/assignees`, { userIds: [person.id] });
      await s.owner.browser.patch(`/api/items/${id}`, { fields: { [supplier.id]: option } });
      return id;
    };
    const fits = await made('Ana com Alfa', s.ana, alfa);
    const other = await made('Bruno com Alfa', s.bruno, alfa);
    const wrong = await made('Ana com Beta', s.ana, beta);
    for (const id of [fits, other, wrong]) await moveTo(s.owner, id, stage.active);
    expect((await itemOf(fits))?.priority).toBe(2);
    expect((await itemOf(other))?.priority).toBeNull();
    expect((await itemOf(wrong))?.priority).toBeNull();

    // Paused, it does nothing.
    await s.owner.browser.patch(`/api/automations/${onStage.body.id}`, { enabled: false });
    const later = await made('Ana com Alfa, depois', s.ana, alfa);
    await moveTo(s.owner, later, stage.active);
    expect((await itemOf(later))?.priority).toBeNull();
  });

  it('takes setting the same stage again as no change, and leaves the trash alone', async () => {
    const rule = await save(s.owner, {
      name: 'Toda nova, e quem volta para o começo',
      trigger: { on: 'stage', to: stage.open },
      actions: [{ do: 'priority', to: 1 }],
    });
    const created = await save(s.owner, {
      name: 'Toda nova',
      trigger: { on: 'created' },
      actions: [{ do: 'priority', to: 1 }],
    });
    const id = await newItem('Parada');
    await env.admin.query('UPDATE app.items SET priority = NULL WHERE id = $1', [id]);
    expect(await bind(app, s.owner)).toBe(true);
    await app.query('UPDATE app.items SET stage_id = stage_id WHERE id = $1', [id]);
    // Made and thrown away in the same request: no rule looks at it.
    const thrown = await app.query<{ id: string }>(
      `INSERT INTO app.items (id, list_id, title) VALUES (gen_random_uuid(), $1, 'Descartada')
       RETURNING id`,
      [s.tarefas],
    );
    await app.query('UPDATE app.items SET deleted_at = now() WHERE id = $1', [thrown.rows[0]?.id]);
    await app.query('COMMIT');
    expect((await itemOf(id))?.priority).toBeNull();
    expect(await runsOf(rule.body.id)).toHaveLength(0);
    const logged = await env.admin.query('SELECT 1 FROM app.automation_runs WHERE item_id = $1', [
      thrown.rows[0]?.id,
    ]);
    expect(logged.rowCount).toBe(0);
    expect(await runsOf(created.body.id)).toHaveLength(1);
  });

  it('comments what it was given, without the spaces around it', async () => {
    await env.admin.query(
      `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
       VALUES (gen_random_uuid(), $1, 'Direta', '{"on":"created"}',
               '[{"do":"comment","text":"  Bem-vinda.  "}]', $2)`,
      [s.tarefas, s.owner.id],
    );
    const id = await newItem('Com espaços');
    expect((await commentsOf(id)).map((comment) => comment.body)).toEqual(['Bem-vinda.']);
  });

  it('gives the person back their own identity when it ends', async () => {
    await save(s.owner, {
      name: 'Em andamento',
      trigger: { on: 'stage', to: stage.active },
      actions: [{ do: 'priority', to: 2 }],
    });
    const id = await newItem('Quem sou eu');
    await s.owner.browser.put(`/api/items/${id}/assignees`, { userIds: [s.ana.id] });
    expect(await bind(app, s.ana)).toBe(true);
    const who =
      'SELECT authz.uid() AS uid, authz.automation_id() AS rule, authz.step_up_ok() AS step';
    const before = (await app.query(who)).rows[0] as { step: boolean };
    expect(before.step).toBe(true);
    await app.query('UPDATE app.items SET stage_id = $1 WHERE id = $2', [stage.active, id]);
    const after = await app.query(who);
    expect(after.rows[0]).toEqual({ uid: s.ana.id, rule: null, step: true });
    await app.query('UPDATE app.items SET title = $1 WHERE id = $2', ['Quem sou eu, Ana', id]);
    await app.query('COMMIT');
    const story = await env.admin.query(
      `SELECT what, actor, automation_id IS NOT NULL AS by_rule FROM app.item_changes
       WHERE item_id = $1 AND what IN ('stage', 'priority', 'title') ORDER BY id`,
      [id],
    );
    expect(story.rows).toEqual([
      { what: 'stage', actor: s.ana.id, by_rule: false },
      { what: 'priority', actor: s.owner.id, by_rule: true },
      { what: 'title', actor: s.ana.id, by_rule: false },
    ]);
    await clearRules();
  });

  it('runs for nobody but people signed in: imports and maintenance are left alone', async () => {
    await save(s.owner, {
      name: 'Toda nova',
      trigger: { on: 'created' },
      actions: [{ do: 'priority', to: 1 }],
    });
    const imported = await env.admin.query<{ id: string }>(
      `INSERT INTO app.items (id, list_id, stage_id, title, created_by)
       VALUES (gen_random_uuid(), $1, $2, 'Importada', $3) RETURNING id`,
      [s.tarefas, stage.open, s.owner.id],
    );
    expect((await itemOf(imported.rows[0]?.id ?? ''))?.priority).toBeNull();
    const logged = await env.admin.query('SELECT 1 FROM app.automation_runs WHERE item_id = $1', [
      imported.rows[0]?.id,
    ]);
    expect(logged.rowCount).toBe(0);
    await clearRules();
  });
});

describe('the edges of access', () => {
  it('hands work only to people who work in the list, and tells anyone who sees it', async () => {
    // Nuno is given a look at the list, and nothing more.
    await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
    });
    const assign = await save(s.owner, {
      name: 'Para o Nuno',
      trigger: { on: 'created' },
      actions: [{ do: 'assign', to: s.nuno.id }],
    });
    expect(assign.body.error.code).toBe('cannot_assign_person');
    const tell = await save(s.owner, {
      name: 'Avise o Nuno',
      trigger: { on: 'created' },
      actions: [{ do: 'notify', to: [s.nuno.id, s.bruno.id] }],
    });
    expect(tell.status).toBe(200);
    const audience = (
      await s.owner.browser.get<{ id: string; canWork: boolean }[]>(
        `/api/lists/${s.tarefas}/automation-audience`,
      )
    ).body;
    expect(audience.find((one) => one.id === s.nuno.id)?.canWork).toBe(false);
    expect(audience.find((one) => one.id === s.bruno.id)?.canWork).toBe(true);

    // Bruno sees only his own items: he is not told of Ana's.
    const id = await newItem('Da Ana, só dela', s.ana);
    const told = await env.admin.query<{ user_id: string }>(
      `SELECT user_id FROM app.notifications WHERE item_id = $1 AND kind = 'automation'`,
      [id],
    );
    expect(told.rows).toEqual([{ user_id: s.nuno.id }]);
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1', [s.nuno.id]);
  });

  it('does nothing once its author only looks at the list', async () => {
    const rule = await save(s.marta, {
      name: 'Da Marta',
      trigger: { on: 'stage', to: stage.done },
      actions: [{ do: 'priority', to: 1 }],
    });
    await s.owner.browser.put('/api/grants', {
      userId: s.marta.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
    });
    const id = await newItem('Só olhando');
    await moveTo(s.owner, id, stage.done);
    expect((await itemOf(id))?.priority).toBeNull();
    expect((await runsOf(rule.body.id))[0]).toMatchObject({
      outcome: 'skipped',
      detail: 'no_access',
    });
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2', [
      s.marta.id,
      s.tarefas,
    ]);
  });

  it('does not hand out work for an author who sees only their own items', async () => {
    await s.owner.browser.put('/api/grants', {
      userId: s.marta.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'manage',
      itemScope: 'assigned',
    });
    const rule = await save(s.marta, {
      name: 'Minhas vão para a Ana',
      trigger: { on: 'created' },
      actions: [{ do: 'assign', to: s.ana.id }],
    });
    expect(rule.status).toBe(200);
    const id = await newItem('Da Marta', s.marta);
    expect((await itemOf(id))?.assignees).toEqual([s.marta.id]);
    expect((await runsOf(rule.body.id, s.marta))[0]).toMatchObject({
      outcome: 'failed',
      detail: 'CB001',
    });
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2', [
      s.marta.id,
      s.tarefas,
    ]);
  });

  it('leaves alone what moves to another list, and fields put away', async () => {
    const perfisStage = otherStage;
    await save(
      s.owner,
      { name: 'Chegou', trigger: { on: 'stage' }, actions: [{ do: 'priority', to: 1 }] },
      s.perfis,
    );
    const id = await newItem('De mudança');
    expect(
      (
        await s.owner.browser.post(`/api/items/${id}/move`, {
          listId: s.perfis,
          stageId: perfisStage,
        })
      ).status,
    ).toBe(200);
    const moved = await env.admin.query('SELECT priority FROM app.items WHERE id = $1', [id]);
    expect(moved.rows).toEqual([{ priority: null }]);

    const old = (
      await s.owner.browser.post<typeof supplier>(`/api/lists/${s.tarefas}/fields`, {
        name: 'Antigo',
        kind: 'select',
        config: { options: [{ name: 'Sim' }] },
      })
    ).body;
    await s.owner.browser.patch(`/api/fields/${old.id}`, { archived: true });
    const tried = await save(s.owner, {
      name: 'Pelo antigo',
      trigger: { on: 'created' },
      conditions: [{ if: 'field', field: old.id, is: old.config.options[0]?.id }],
      actions: [{ do: 'priority', to: 1 }],
    });
    expect(tried.body.error.code).toBe('unknown_field');
  });
});

describe('at the database', () => {
  it('lets nobody but managers see rules, or anyone forge who a rule acts as', async () => {
    const rule = await save(s.owner, {
      name: 'Base',
      trigger: { on: 'created' },
      actions: [{ do: 'priority', to: 2 }],
    });
    const id = rule.body.id;

    expect(await bind(app, s.ana)).toBe(true);
    expect((await attempt(app, 'SELECT * FROM app.automations')).rowCount).toBe(0);
    expect((await attempt(app, 'SELECT * FROM app.automation_runs')).rowCount).toBe(0);
    const check = await attempt(
      app,
      `SELECT app.automation_check($1, '{"on":"created"}', '[]', '[{"do":"priority","to":1}]') AS p`,
      [s.tarefas],
    );
    expect(check.rows[0]).toEqual({ p: 'forbidden' });
    expect((await attempt(app, 'SELECT * FROM app.list_audience($1)', [s.tarefas])).rowCount).toBe(
      0,
    );
    await app.query('COMMIT');

    // Nuno sees nothing of the list, so not even the rule's name.
    expect(await bind(app, s.nuno)).toBe(true);
    expect((await attempt(app, 'SELECT app.automation_name($1) AS n', [id])).rows[0]).toEqual({
      n: null,
    });
    await app.query('COMMIT');

    expect(await bind(app, s.marta)).toBe(true);
    expect((await attempt(app, 'SELECT id FROM app.automations')).rowCount).toBe(1);
    const forged = await attempt(
      app,
      `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
       VALUES (gen_random_uuid(), $1, 'Como a dona', '{"on":"created"}', '[{"do":"priority","to":1}]', $2)`,
      [s.tarefas, s.owner.id],
    );
    expect(forged).toMatchObject({ ok: false, code: '42501' });
    expect(
      await attempt(app, `UPDATE app.automations SET run_as = $1 WHERE id = $2`, [s.owner.id, id]),
    ).toMatchObject({ ok: false, code: '42501' });
    expect(
      await attempt(
        app,
        `INSERT INTO app.automation_runs (automation_id, outcome) VALUES ($1, 'done')`,
        [id],
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    const moved = await attempt(app, `UPDATE app.automations SET list_id = $1 WHERE id = $2`, [
      s.perfis,
      id,
    ]);
    expect(moved).toMatchObject({ ok: false, code: '42501' });
    // Her saving it makes it hers.
    await app.query(`UPDATE app.automations SET name = 'Base da Marta' WHERE id = $1`, [id]);
    await app.query('COMMIT');
    const owner = await env.admin.query('SELECT run_as FROM app.automations WHERE id = $1', [id]);
    expect(owner.rows[0]).toEqual({ run_as: s.marta.id });

    // Editing items is not managing the list, capability or not.
    await s.owner.browser.put(`/api/users/${s.ana.id}/capabilities`, {
      capabilities: ['automations.manage'],
    });
    expect(await bind(app, s.ana)).toBe(true);
    expect(
      await attempt(
        app,
        `INSERT INTO app.automations (id, list_id, name, trigger, actions)
         VALUES (gen_random_uuid(), $1, 'Da Ana', '{"on":"created"}', '[{"do":"priority","to":1}]')`,
        [s.tarefas],
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    await app.query('COMMIT');
    await s.owner.browser.put(`/api/users/${s.ana.id}/capabilities`, { capabilities: [] });

    // Without the capability, writing is refused even straight at the database.
    await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve'],
    });
    expect(await bind(app, s.marta)).toBe(true);
    await app.query(`UPDATE app.automations SET enabled = false`);
    expect(
      await attempt(
        app,
        `INSERT INTO app.automations (id, list_id, name, trigger, actions)
         VALUES (gen_random_uuid(), $1, 'Nova', '{"on":"created"}', '[{"do":"priority","to":1}]')`,
        [s.tarefas],
      ),
    ).toMatchObject({ ok: false, code: '42501' });
    await app.query('DELETE FROM app.automations');
    await app.query('COMMIT');
    const kept = await env.admin.query('SELECT enabled FROM app.automations WHERE id = $1', [id]);
    expect(kept.rows).toEqual([{ enabled: true }]);
    await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
    });
    await clearRules();
  });

  it('checks every rule written, whoever writes it', async () => {
    const insert = (list: string, trigger: unknown, conditions: unknown, actions: unknown) =>
      env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, conditions, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', $2, $3, $4, $5)`,
          [
            list,
            JSON.stringify(trigger),
            JSON.stringify(conditions),
            JSON.stringify(actions),
            s.owner.id,
          ],
        )
        .then(
          () => 'ok',
          (error: unknown) => messageOf(error).replace('rule not valid: ', ''),
        );
    const p1 = [{ do: 'priority', to: 1 }];
    const kindOf = async (kind: string): Promise<string> =>
      (
        await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/fields`, {
          name: `Campo ${kind}`,
          kind,
        })
      ).body.id;
    const box = await kindOf('checkbox');
    const note = await kindOf('text');
    expect(
      await insert(s.tarefas, { on: 'created' }, [{ if: 'field', field: box, is: 'sim' }], p1),
    ).toBe('unknown_field');
    expect(
      await insert(s.tarefas, { on: 'created' }, [{ if: 'field', field: note, is: 'sim' }], p1),
    ).toBe('unknown_field');
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'assign', to: 'x' }])).toBe(
      'unknown_person',
    );
    expect(await insert(s.dinheiro, { on: 'created' }, [], p1)).toBe('sensitive_list');
    expect(await insert(s.tarefas, { on: 'moved' }, [], p1)).toBe('bad_trigger');
    expect(await insert(s.tarefas, [], [], p1)).toBe('bad_trigger');
    expect(await insert(s.tarefas, { on: 'created', to: stage.done }, [], p1)).toBe('bad_trigger');
    expect(await insert(s.tarefas, { on: 'stage', at: stage.done }, [], p1)).toBe('bad_trigger');
    expect(await insert(s.tarefas, { on: 'stage', from: otherStage }, [], p1)).toBe(
      'unknown_stage',
    );
    expect(await insert(s.tarefas, { on: 'created' }, {}, p1)).toBe('bad_conditions');
    expect(
      await insert(s.tarefas, { on: 'created' }, Array(11).fill({ if: 'priority', is: 1 }), p1),
    ).toBe('bad_conditions');
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'priority' }], p1)).toBe(
      'bad_conditions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'priority', is: '1' }], p1)).toBe(
      'bad_conditions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'title', is: 'x' }], p1)).toBe(
      'bad_conditions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'stage', is: otherStage }], p1)).toBe(
      'unknown_stage',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'assignee' }], p1)).toBe(
      'unknown_person',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [{ if: 'assignee', is: 'x' }], p1)).toBe(
      'unknown_person',
    );
    expect(
      await insert(s.tarefas, { on: 'created' }, [{ if: 'field', field: supplier.id, is: 1 }], p1),
    ).toBe('unknown_field');
    expect(await insert(s.tarefas, { on: 'created' }, [], [])).toBe('bad_actions');
    expect(await insert(s.tarefas, { on: 'created' }, [], Array(6).fill(p1[0]))).toBe(
      'bad_actions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], {})).toBe('bad_actions');
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'priority' }])).toBe(
      'bad_actions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'priority', to: 5 }])).toBe(
      'bad_actions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'stage', to: otherStage }])).toBe(
      'unknown_stage',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'assign' }])).toBe(
      'cannot_assign_person',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'notify', to: [] }])).toBe(
      'bad_actions',
    );
    expect(
      await insert(
        s.tarefas,
        { on: 'created' },
        [],
        [{ do: 'notify', to: Array(11).fill(s.ana.id) }],
      ),
    ).toBe('bad_actions');
    expect(
      await insert(s.tarefas, { on: 'created' }, [], [{ do: 'notify', to: [s.nuno.id] }]),
    ).toBe('cannot_notify_person');
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'comment', text: '   ' }])).toBe(
      'bad_actions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'comment', text: 7 }])).toBe(
      'bad_actions',
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], [{ do: 'reload' }])).toBe('bad_actions');
    expect(
      await insert(
        s.tarefas,
        { on: 'stage', from: stage.open, to: stage.done },
        [],
        [
          { do: 'notify', to: [s.ana.id] },
          { do: 'comment', text: 'ok' },
          { do: 'assign', to: s.ana.id },
          { do: 'priority', to: null },
        ],
      ),
    ).toBe('ok');
    // At most 50 rules in a list.
    await env.admin.query(
      `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
       SELECT gen_random_uuid(), $1, 'Lote ' || n, '{"on":"created"}', '[{"do":"priority","to":1}]', $2
       FROM generate_series(2, 50) n`,
      [s.tarefas, s.owner.id],
    );
    expect(await insert(s.tarefas, { on: 'created' }, [], p1)).toBe('at most 50 rules in a list');
    expect(
      (await save(s.owner, { name: 'Mais uma', trigger: { on: 'created' }, actions: p1 })).body
        .error.code,
    ).toBe('too_many_automations');
    // When it was made is the database's to say, and so is when it last changed.
    await env.admin.query(
      `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'Antiga', '{"on":"created"}', '[{"do":"priority","to":1}]', $2,
               '2001-01-01', '2001-01-01')`,
      [s.perfis, s.owner.id],
    );
    await env.admin.query(
      `UPDATE app.automations SET enabled = false, created_at = '2001-01-01',
                                  updated_at = '2001-01-01'`,
    );
    const dated = await env.admin.query<{ old: number }>(
      `SELECT count(*)::int AS old FROM app.automations
       WHERE created_at < '2002-01-01' OR updated_at < '2002-01-01'`,
    );
    expect(dated.rows[0]?.old).toBe(0);
    const anyRule = await env.admin.query<{ id: string }>('SELECT id FROM app.automations LIMIT 1');
    expect(
      await env.admin
        .query('UPDATE app.automations SET list_id = $1 WHERE id = $2', [
          s.perfis,
          anyRule.rows[0]?.id,
        ])
        .then(
          () => 'ok',
          (error: unknown) => messageOf(error),
        ),
    ).toBe('a rule stays on its list');
    await clearRules();
  });

  it('keeps the log as it was, and lets go of it after 90 days', async () => {
    const rule = await save(s.owner, {
      name: 'Registrada',
      trigger: { on: 'created' },
      actions: [{ do: 'priority', to: 4 }],
    });
    const id = await newItem('Deixa rastro');
    const run = await env.admin.query<{ id: string }>(
      'SELECT id FROM app.automation_runs WHERE automation_id = $1',
      [rule.body.id],
    );
    const runId = run.rows[0]?.id ?? '';
    const refuse = (text: string, values: unknown[]) =>
      env.admin.query(text, values).then(
        () => 'ok',
        (error: unknown) => codeOf(error),
      );
    expect(
      await refuse(
        `UPDATE app.automation_runs SET outcome = 'failed', detail = 'x' WHERE id = $1`,
        [runId],
      ),
    ).toBe('CB001');
    expect(
      await refuse(`UPDATE app.automation_runs SET at = now() - interval '1 year' WHERE id = $1`, [
        runId,
      ]),
    ).toBe('CB001');
    expect(await refuse('DELETE FROM app.automation_runs WHERE id = $1', [runId])).toBe('CB001');
    // The item removed for good: the entry stays, without it.
    await env.admin.query('ALTER TABLE app.items DISABLE TRIGGER trash_guard');
    await env.admin.query('DELETE FROM app.items WHERE id = $1', [id]);
    await env.admin.query('ALTER TABLE app.items ENABLE TRIGGER trash_guard');
    expect((await runsOf(rule.body.id))[0]).toMatchObject({ outcome: 'done', itemId: null });

    await env.admin.query('ALTER TABLE app.automation_runs DISABLE TRIGGER keep');
    await env.admin.query(
      `UPDATE app.automation_runs SET at = now() - interval '91 days' WHERE id = $1`,
      [runId],
    );
    await env.admin.query('ALTER TABLE app.automation_runs ENABLE TRIGGER keep');
    await env.admin.query(
      `INSERT INTO app.automation_runs (automation_id, outcome) VALUES ($1, 'done')`,
      [rule.body.id],
    );
    expect(await bind(app, s.owner)).toBe(true);
    expect((await app.query('SELECT app.purge_automation_runs() AS n')).rows[0]).toEqual({ n: 1 });
    await app.query('COMMIT');
    expect(await runsOf(rule.body.id)).toHaveLength(1);
    // Removing the rule takes its log with it.
    await s.owner.browser.delete(`/api/automations/${rule.body.id}`);
    const left = await env.admin.query(
      'SELECT 1 FROM app.automation_runs WHERE automation_id = $1',
      [rule.body.id],
    );
    expect(left.rowCount).toBe(0);
    await clearRules();
  });

  it('starts every request with no rule acting', async () => {
    const pid = (await app.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    expect(await bind(app, s.ana)).toBe(true);
    await app.query('COMMIT');
    await env.admin.query(
      `UPDATE authz.request_ctx SET automation_id = gen_random_uuid(), automation_depth = 3
       WHERE pid = $1`,
      [pid],
    );
    expect(await bind(app, s.ana)).toBe(true);
    const fresh = await app.query('SELECT authz.automation_id() AS rule');
    expect(fresh.rows[0]).toEqual({ rule: null });
    await app.query('COMMIT');
    const depth = await env.admin.query(
      'SELECT automation_depth FROM authz.request_ctx WHERE pid = $1',
      [pid],
    );
    expect(depth.rows).toEqual([{ automation_depth: 0 }]);
  });
});
