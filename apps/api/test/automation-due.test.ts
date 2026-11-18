import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Rules that act when an item's due date comes. Nobody is signed in then: the
 * hourly job runs them, each as its author and only for the rule, once per
 * item and due date. The job can never be used from inside a request.
 */

interface Item {
  id: string;
  priority: number | null;
  stageId: string;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let job: pg.Client;
let done: string;
let active: string;

const day = async (offset: number): Promise<string> =>
  (await env.admin.query<{ d: string }>(`SELECT (current_date + $1::integer)::text AS d`, [offset]))
    .rows[0]?.d ?? '';
const newItem = async (title: string, dueIn: number | null): Promise<string> => {
  const id = (
    await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })
  ).body.id;
  if (dueIn !== null) {
    await s.owner.browser.patch(`/api/items/${id}`, { dueDate: await day(dueIn) });
  }
  return id;
};
const itemOf = async (id: string): Promise<Item | undefined> =>
  (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
    (item) => item.id === id,
  );
const save = (body: Record<string, unknown>) =>
  s.owner.browser.post<{ id: string } & ErrorBody>(`/api/lists/${s.tarefas}/automations`, body);
/** What the hourly job does: no session, its own transaction. */
const runJob = async (): Promise<number> =>
  (await job.query<{ ran: number }>('SELECT app.automations_due() AS ran')).rows[0]?.ran ?? -1;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  job = await connectAs(env, 'cerebro_app');
  const stages = (
    await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
  done = stages.find((stage) => stage.kind === 'done')?.id ?? '';
  active = stages.find((stage) => stage.kind === 'active')?.id ?? '';
});
beforeEach(async () => {
  await env.admin.query('DELETE FROM app.automations');
  await env.admin.query(
    `UPDATE app.items SET due_date = NULL WHERE due_date IS NOT NULL AND deleted_at IS NULL`,
  );
});
afterAll(async () => {
  await app.end();
  await job.end();
  await env.close();
});

describe('saying when the due date comes', () => {
  it('takes days before, on the day or late, up to 30', async () => {
    for (const offset of [31, -31, 1.5]) {
      const tried = await save({
        name: 'Prazo',
        trigger: { on: 'due', offset },
        actions: [{ do: 'priority', to: 1 }],
      });
      expect(tried.body.error.code, String(offset)).toBe('invalid_input');
    }
    const insert = (trigger: unknown) =>
      env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', $2, '[{"do":"priority","to":1}]', $3)`,
          [s.tarefas, JSON.stringify(trigger), s.owner.id],
        )
        .then(
          () => 'ok',
          (error: unknown) =>
            error instanceof Error ? error.message.replace('rule not valid: ', '') : 'erro',
        );
    for (const trigger of [
      { on: 'due' },
      { on: 'due', offset: '1' },
      { on: 'due', offset: 31 },
      { on: 'due', offset: -31 },
      { on: 'due', offset: 0.5 },
      { on: 'due', offset: 0, to: 'x' },
    ]) {
      expect(await insert(trigger), JSON.stringify(trigger)).toBe('bad_trigger');
    }
    // The rest of the rule is checked as for any other.
    const other = await env.admin.query<{ id: string }>(
      'SELECT id FROM app.list_stages WHERE list_id = $1 LIMIT 1',
      [s.perfis],
    );
    expect(
      await env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', '{"on":"due","offset":0}', $2, $3)`,
          [s.tarefas, JSON.stringify([{ do: 'stage', to: other.rows[0]?.id }]), s.owner.id],
        )
        .then(
          () => 'ok',
          (error: unknown) => (error instanceof Error ? error.message : 'erro'),
        ),
    ).toBe('rule not valid: unknown_stage');
    expect(await insert({ on: 'due', offset: -30 })).toBe('ok');
    expect(await insert({ on: 'due', offset: 30 })).toBe('ok');
    expect(
      await env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', '{"on":"due","offset":0}', '[]', $2)`,
          [s.tarefas, s.owner.id],
        )
        .then(
          () => 'ok',
          (error: unknown) => (error instanceof Error ? error.message : 'erro'),
        ),
    ).toBe('rule not valid: bad_actions');
    // A sensitive list takes no rules, this kind included.
    expect(
      await env.admin
        .query(
          `INSERT INTO app.automations (id, list_id, name, trigger, actions, run_as)
           VALUES (gen_random_uuid(), $1, 'Direta', '{"on":"due","offset":0}',
                   '[{"do":"priority","to":1}]', $2)`,
          [s.dinheiro, s.owner.id],
        )
        .then(
          () => 'ok',
          (error: unknown) => (error instanceof Error ? error.message : 'erro'),
        ),
    ).toBe('rule not valid: sensitive_list');
  });
});

describe('when the due date comes', () => {
  it('acts on unfinished items due that day, as its author, once', async () => {
    const rule = await save({
      name: 'Vence hoje',
      trigger: { on: 'due', offset: 0 },
      actions: [
        { do: 'priority', to: 1 },
        { do: 'notify', to: [s.owner.id, s.marta.id] },
      ],
    });
    expect(rule.status).toBe(200);
    const today = await newItem('Vence hoje', 0);
    const tomorrow = await newItem('Vence amanhã', 1);
    const finished = await newItem('Já feito', 0);
    await s.owner.browser.patch(`/api/items/${finished}`, { stageId: done });
    const trashed = await newItem('Na lixeira', 0);
    await s.owner.browser.post(`/api/items/${trashed}/trash`);

    expect(await runJob()).toBe(1);
    expect((await itemOf(today))?.priority).toBe(1);
    expect((await itemOf(tomorrow))?.priority).toBeNull();
    expect((await itemOf(finished))?.priority).toBeNull();
    const story = await env.admin.query(
      `SELECT actor, automation_id FROM app.item_changes WHERE item_id = $1 AND what = 'priority'`,
      [today],
    );
    expect(story.rows).toEqual([{ actor: s.owner.id, automation_id: rule.body.id }]);
    // Nobody set it off, so the author is told too.
    const told = await env.admin.query<{ user_id: string }>(
      `SELECT user_id FROM app.notifications WHERE item_id = $1 AND kind = 'automation'
       ORDER BY user_id`,
      [today],
    );
    expect(told.rows.map((row) => row.user_id).sort()).toEqual([s.owner.id, s.marta.id].sort());

    // An hour later, nothing again; nor after the person sets it back.
    await env.admin.query('UPDATE app.items SET priority = NULL WHERE id = $1', [today]);
    expect(await runJob()).toBe(0);
    expect((await itemOf(today))?.priority).toBeNull();
    // A new due date is a new occasion: an item the rule acted on for an earlier due date.
    await env.admin.query(
      `INSERT INTO app.automation_due_seen (automation_id, item_id, due_on)
       VALUES ($1, $2, current_date - 40), ($1, $3, current_date - 5)`,
      [rule.body.id, today, tomorrow],
    );
    await s.owner.browser.patch(`/api/items/${tomorrow}`, { dueDate: await day(0) });
    expect(await runJob()).toBe(1);
    expect((await itemOf(tomorrow))?.priority).toBe(1);
    // What is long past is let go.
    const old = await env.admin.query(
      'SELECT 1 FROM app.automation_due_seen WHERE due_on < current_date - 31',
    );
    expect(old.rowCount).toBe(0);
  });

  it('acts days before and days late, and only when the rule says', async () => {
    await save({
      name: 'Faltam dois dias',
      trigger: { on: 'due', offset: -2 },
      actions: [{ do: 'priority', to: 2 }],
    });
    await save({
      name: 'Um dia atrasado',
      trigger: { on: 'due', offset: 1 },
      conditions: [{ if: 'priority', is: null }],
      actions: [{ do: 'stage', to: active }],
    });
    const soon = await newItem('Daqui a dois dias', 2);
    const late = await newItem('Venceu ontem', -1);
    const later = await newItem('Venceu anteontem', -2);
    const paused = await save({
      name: 'Pausada',
      trigger: { on: 'due', offset: 0 },
      enabled: false,
      actions: [{ do: 'priority', to: 4 }],
    });
    const due = await newItem('Hoje, regra pausada', 0);
    expect(await runJob()).toBe(2);
    expect((await itemOf(soon))?.priority).toBe(2);
    expect((await itemOf(late))?.stageId).toBe(active);
    expect((await itemOf(later))?.stageId).not.toBe(active);
    expect((await itemOf(due))?.priority).toBeNull();
    expect(paused.status).toBe(200);
  });

  it('does nothing its author could not, and starts the rules it sets off', async () => {
    const rule = await s.marta.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/automations`, {
      name: 'Da Marta',
      trigger: { on: 'due', offset: 0 },
      actions: [{ do: 'priority', to: 1 }],
    });
    // Marta lacks the capability here: the owner writes it for her, then she saves it.
    expect(rule.status).toBe(403);
    await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
    });
    const hers = await s.marta.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/automations`, {
      name: 'Da Marta',
      trigger: { on: 'due', offset: 0 },
      actions: [{ do: 'stage', to: active }],
    });
    await save({
      name: 'Andou, urgente',
      trigger: { on: 'stage', to: active },
      actions: [{ do: 'priority', to: 1 }],
    });
    const id = await newItem('Corrente do prazo', 0);
    expect(await runJob()).toBe(1);
    expect(await itemOf(id)).toMatchObject({ stageId: active, priority: 1 });
    const marks = await env.admin.query<{ what: string; actor: string }>(
      `SELECT what, actor FROM app.item_changes
       WHERE item_id = $1 AND what IN ('stage', 'priority') ORDER BY id`,
      [id],
    );
    expect(marks.rows).toEqual([
      { what: 'stage', actor: s.marta.id },
      { what: 'priority', actor: s.owner.id },
    ]);

    // Without access, it is noted and does nothing.
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1', [s.marta.id]);
    const other = await newItem('Sem a Marta', 0);
    expect(await runJob()).toBe(1);
    expect((await itemOf(other))?.stageId).not.toBe(active);
    const runs = (
      await s.owner.browser.get<{ outcome: string; detail: string | null }[]>(
        `/api/automations/${hers.body.id}/runs`,
      )
    ).body;
    expect(runs[0]).toMatchObject({ outcome: 'skipped', detail: 'no_access' });
    await s.owner.browser.put('/api/grants', {
      userId: s.marta.id,
      scopeType: 'space',
      scopeId: s.operacao,
      level: 'manage',
    });
  });

  it('leaves nobody acting afterwards, and refuses to run inside a request', async () => {
    await save({
      name: 'Hoje',
      trigger: { on: 'due', offset: 0 },
      actions: [{ do: 'priority', to: 3 }],
    });
    await newItem('Qualquer', 0);
    await job.query('BEGIN');
    expect(
      (await job.query<{ ran: number }>('SELECT app.automations_due() AS ran')).rows[0]?.ran,
    ).toBe(1);
    const after = await job.query(
      `SELECT authz.uid() AS uid, authz.automation_id() AS rule,
              (SELECT count(*)::int FROM app.items) AS seen`,
    );
    expect(after.rows[0]).toEqual({ uid: null, rule: null, seen: 0 });
    await job.query('COMMIT');

    expect(await bind(app, s.ana)).toBe(true);
    expect(await attempt(app, 'SELECT app.automations_due()')).toMatchObject({
      ok: false,
      code: 'CB001',
    });
    await app.query('ROLLBACK');
  });
});
