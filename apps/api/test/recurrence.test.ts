import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Recurring items: whoever edits an item makes it repeat; reaching a finished
 * stage makes the next one, by any path, with what the item carried and its
 * dates moved on; the rule goes with it. By the API and at the database.
 */

interface Item {
  id: string;
  title: string;
  description: string;
  stageId: string;
  priority: number | null;
  startDate: string | null;
  dueDate: string | null;
  assignees: string[];
  fields: Record<string, unknown>;
  parentId: string | null;
  checks: { done: number; total: number };
  recurrence: { unit: string; every: number } | null;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stage: { open: string; active: string; done: string };

const items = async (person: Person = s.owner): Promise<Item[]> =>
  (await person.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
const newItem = async (title: string, body: Record<string, unknown> = {}): Promise<string> => {
  const id = (
    await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })
  ).body.id;
  if (Object.keys(body).length > 0) await s.owner.browser.patch(`/api/items/${id}`, body);
  return id;
};
const repeat = (person: Person, itemId: string, unit: string, every: number) =>
  person.browser.put<Item & ErrorBody>(`/api/items/${itemId}/recurrence`, { unit, every });
const moveTo = (person: Person, itemId: string, stageId: string) =>
  person.browser.patch<Item & ErrorBody>(`/api/items/${itemId}`, { stageId });
const day = async (expression: string): Promise<string> =>
  (await env.admin.query<{ d: string }>(`SELECT (${expression})::date::text AS d`)).rows[0]?.d ??
  '';
const nextOf = async (oldId: string): Promise<Item | undefined> => {
  const found = await env.admin.query<{ item_id: string }>(
    `SELECT item_id FROM app.item_changes WHERE what = 'repeated' AND new = to_jsonb($1::text)`,
    [oldId],
  );
  const id = found.rows[0]?.item_id;
  return (await items()).find((item) => item.id === id);
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const stages = (
    await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
  const of = (kind: string): string => stages.find((one) => one.kind === kind)?.id ?? '';
  stage = { open: of('open'), active: of('active'), done: of('done') };
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('setting the rule', () => {
  it('is for whoever edits the item, and is written in its history', async () => {
    const set = await repeat(s.ana, s.itemAna, 'week', 1);
    expect(set.body.recurrence).toEqual({ unit: 'week', every: 1 });
    expect((await repeat(s.ana, s.itemAna, 'month', 2)).body.recurrence).toEqual({
      unit: 'month',
      every: 2,
    });
    expect((await repeat(s.ana, s.itemBruno, 'day', 1)).status).toBe(404);
    for (const body of [
      { unit: 'hour', every: 1 },
      { unit: 'day', every: 0 },
      { unit: 'day', every: 100 },
    ]) {
      const tried = await s.ana.browser.put(`/api/items/${s.itemAna}/recurrence`, body);
      expect(tried.status, JSON.stringify(body)).toBe(400);
    }
    const cleared = await s.ana.browser.delete<Item>(`/api/items/${s.itemAna}/recurrence`);
    expect(cleared.body.recurrence).toBeNull();
    const story = await env.admin.query(
      `SELECT actor, old, new FROM app.item_changes
       WHERE item_id = $1 AND what = 'recurrence' ORDER BY id`,
      [s.itemAna],
    );
    expect(story.rows).toEqual([
      { actor: s.ana.id, old: null, new: { unit: 'week', every: 1 } },
      { actor: s.ana.id, old: { unit: 'week', every: 1 }, new: { unit: 'month', every: 2 } },
      { actor: s.ana.id, old: { unit: 'month', every: 2 }, new: null },
    ]);
  });
});

describe('finishing a recurring item', () => {
  it('makes the next one with what it carried, its dates a step on, and passes the rule', async () => {
    const due = await day('current_date + 3');
    const start = await day('current_date + 2');
    const field = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/fields`, {
        name: 'Cliente',
        kind: 'text',
      })
    ).body.id;
    const id = await newItem('Relatório quinzenal', {
      description: 'Fechar os números.',
      priority: 2,
      startDate: start,
      dueDate: due,
      fields: { [field]: 'Loja Exemplo' },
    });
    await s.owner.browser.put(`/api/items/${id}/assignees`, { userIds: [s.ana.id] });
    const first = await s.owner.browser.post<{ id: string }>(`/api/items/${id}/checklist`, {
      text: 'Puxar dados',
    });
    await s.owner.browser.post(`/api/items/${id}/checklist`, { text: 'Revisar' });
    await s.owner.browser.patch(`/api/checklist/${first.body.id}`, { done: true });
    await repeat(s.owner, id, 'week', 2);

    expect((await moveTo(s.marta, id, stage.done)).status).toBe(200);
    const next = await nextOf(id);
    expect(next).toMatchObject({
      title: 'Relatório quinzenal',
      description: 'Fechar os números.',
      stageId: stage.open,
      priority: 2,
      startDate: await day(`date '${start}' + 14`),
      dueDate: await day(`date '${due}' + 14`),
      assignees: [s.ana.id],
      fields: { [field]: 'Loja Exemplo' },
      checks: { done: 0, total: 2 },
      recurrence: { unit: 'week', every: 2 },
    });
    expect((await items()).find((item) => item.id === id)?.recurrence).toBeNull();
    // Finishing it again makes nothing more: the rule moved on.
    await moveTo(s.marta, id, stage.active);
    await moveTo(s.marta, id, stage.done);
    const made = await env.admin.query(
      `SELECT 1 FROM app.item_changes WHERE what = 'repeated' AND new = to_jsonb($1::text)`,
      [id],
    );
    expect(made.rowCount).toBe(1);
  });

  it('lands today or later when finished late, and a step after today without a due date', async () => {
    const late = await newItem('Atrasado semanal', { dueDate: await day('current_date - 20') });
    await repeat(s.owner, late, 'week', 1);
    await moveTo(s.owner, late, stage.done);
    // Three whole weeks after the last due date: the first one not in the past.
    expect((await nextOf(late))?.dueDate).toBe(await day('current_date + 1'));

    const loose = await newItem('Sem prazo diário');
    await repeat(s.owner, loose, 'day', 1);
    await moveTo(s.owner, loose, stage.done);
    expect((await nextOf(loose))?.dueDate).toBe(await day('current_date + 1'));

    const monthEnd = await day(`make_date(extract(year FROM current_date)::int + 1, 1, 31)`);
    const monthly = await newItem('Fechamento', { dueDate: monthEnd });
    await repeat(s.owner, monthly, 'month', 1);
    await moveTo(s.owner, monthly, stage.done);
    // The last day of February, not the 3rd of March.
    expect((await nextOf(monthly))?.dueDate).toBe(
      await day(`date '${monthEnd}' + interval '1 month'`),
    );
    expect((await nextOf(monthly))?.dueDate?.slice(5, 7)).toBe('02');
  });

  it('does nothing between open stages, from finished to finished, or without a rule', async () => {
    const id = await newItem('Sem pressa');
    await repeat(s.owner, id, 'day', 1);
    await moveTo(s.owner, id, stage.active);
    await moveTo(s.owner, id, stage.open);
    expect(await nextOf(id)).toBeUndefined();
    // Done, then the rule, then closed: it was already finished.
    const closed = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/stages`, {
        name: 'Cancelado',
        kind: 'closed',
      })
    ).body.id;
    const over = await newItem('Já feito');
    await moveTo(s.owner, over, stage.done);
    await repeat(s.owner, over, 'day', 1);
    await moveTo(s.owner, over, closed);
    expect(await nextOf(over)).toBeUndefined();
    // In the trash, not even when its stage is removed into a finished one.
    const waiting = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/stages`, {
        name: 'Esperando',
        kind: 'active',
      })
    ).body.id;
    const binned = await newItem('Jogado fora');
    await moveTo(s.owner, binned, waiting);
    await repeat(s.owner, binned, 'day', 1);
    await s.owner.browser.post(`/api/items/${binned}/trash`, {});
    const removed = await s.owner.browser.delete(`/api/stages/${waiting}`, { moveTo: stage.done });
    expect(removed.status).toBe(200);
    expect(await nextOf(binned)).toBeUndefined();
    const plain = await newItem('Uma vez só');
    const before = (await items()).length;
    await moveTo(s.owner, plain, stage.done);
    expect((await items()).length).toBe(before);
  });

  it('gives the next one to whoever finished it, also for an employee, and keeps the parent', async () => {
    const hers = (
      await s.ana.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Postar no feed',
      })
    ).body.id;
    await repeat(s.ana, hers, 'day', 1);
    expect((await moveTo(s.ana, hers, stage.done)).status).toBe(200);
    const next = await nextOf(hers);
    expect(next).toBeDefined();
    expect((await items(s.ana)).some((item) => item.id === next?.id)).toBe(true);

    const parent = await newItem('Campanha mensal');
    const child = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Relatório da campanha',
        parentId: parent,
      })
    ).body.id;
    await repeat(s.owner, child, 'month', 1);
    await moveTo(s.owner, child, stage.done);
    expect((await nextOf(child))?.parentId).toBe(parent);
  });
});

describe('straight at the database', () => {
  it('sets rules only for items the person edits, and keeps them still in the trash', async () => {
    const o = s.owner.browser;
    const showcase = (
      await o.post<{ id: string }>('/api/lists', { spaceId: s.financeiro, name: 'Agenda' })
    ).body.id;
    const shown = (await o.post<{ id: string }>(`/api/lists/${showcase}/items`, { title: 'Ver' }))
      .body.id;
    await o.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: showcase,
      level: 'view',
      itemScope: 'all',
    });
    expect(await bind(app, s.bruno)).toBe(true);
    for (const target of [shown, s.itemAna]) {
      const tried = await attempt(
        app,
        `INSERT INTO app.item_recurrences (item_id, unit, every) VALUES ($1, 'day', 1)`,
        [target],
      );
      expect(tried.ok).toBe(false);
    }
    const forged = await attempt(
      app,
      `INSERT INTO app.item_changes (item_id, what, new) VALUES ($1, 'repeated', '"x"')`,
      [s.itemBruno],
    );
    expect(forged.ok).toBe(false);
    // Rules come in whole units, from once to 99 at a time.
    for (const [unit, every] of [
      ['hour', 1],
      ['day', 0],
      ['day', 100],
    ] as const) {
      expect(
        await attempt(
          app,
          `INSERT INTO app.item_recurrences (item_id, unit, every) VALUES ($1, $2, $3)`,
          [s.itemBruno, unit, every],
        ),
        `${unit} ${String(every)}`,
      ).toMatchObject({ ok: false, code: '23514' });
    }
    await app.query('ROLLBACK');
    // Bruno does not read the rule of an item he does not see.
    await repeat(s.ana, s.itemAna, 'day', 3);
    expect(await bind(app, s.bruno)).toBe(true);
    expect(
      await attempt(app, `SELECT 1 FROM app.item_recurrences WHERE item_id = $1`, [s.itemAna]),
    ).toMatchObject({ ok: true, rowCount: 0 });
    await app.query('ROLLBACK');
    await s.ana.browser.delete(`/api/items/${s.itemAna}/recurrence`);

    const binned = await newItem('Na lixeira');
    await repeat(s.owner, binned, 'day', 1);
    await o.post(`/api/items/${binned}/trash`, {});
    expect(await bind(app, s.owner)).toBe(true);
    for (const text of [
      `UPDATE app.item_recurrences SET every = 3 WHERE item_id = $1`,
      `DELETE FROM app.item_recurrences WHERE item_id = $1`,
    ]) {
      expect(await attempt(app, text, [binned]), text).toMatchObject({ ok: false, code: 'CB003' });
    }
    await app.query('ROLLBACK');
  });

  it('repeats on any path, and stamps who set the rule', async () => {
    const hers = (
      await s.ana.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Direto no banco',
      })
    ).body.id;
    expect(await bind(app, s.ana)).toBe(true);
    const set = await attempt(
      app,
      `INSERT INTO app.item_recurrences (item_id, unit, every) VALUES ($1, 'week', 1)
       RETURNING set_by`,
      [hers],
    );
    expect(set.rows[0]?.set_by).toBe(s.ana.id);
    const finished = await attempt(app, `UPDATE app.items SET stage_id = $2 WHERE id = $1`, [
      hers,
      stage.done,
    ]);
    expect(finished).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('COMMIT');
    const next = await nextOf(hers);
    expect(next?.recurrence).toEqual({ unit: 'week', every: 1 });
    // Not even the owner of the database moves a rule to another item.
    await expect(
      env.admin.query(`UPDATE app.item_recurrences SET item_id = $2 WHERE item_id = $1`, [
        next?.id,
        s.itemAna,
      ]),
    ).rejects.toMatchObject({ code: 'CB003' });
  });
});
