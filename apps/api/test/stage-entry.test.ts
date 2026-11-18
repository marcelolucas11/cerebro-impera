import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * A stage may say that only people from a given role up put items into it.
 * Every way in is checked: moving, creating straight into it, in bulk, and a
 * rule acting as its author. Landing in a list's first stage on its own is
 * not choosing it. By the API and at the database.
 */

interface Stage {
  id: string;
  name: string;
  kind: string;
  entryRole: string | null;
}
interface Item {
  id: string;
  stageId: string;
  title: string;
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stages: Stage[];
let blocked: Stage;
let first: Stage;

const stageOf = async (id: string): Promise<string | undefined> =>
  (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
    (item) => item.id === id,
  )?.stageId;
const moveTo = (person: Person, id: string, stageId: string) =>
  person.browser.patch<Item & ErrorBody>(`/api/items/${id}`, { stageId });
const restrict = (stage: Stage, entryRole: string | null) =>
  s.owner.browser.patch<Stage & ErrorBody>(`/api/stages/${stage.id}`, { entryRole });

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  blocked = (
    await s.owner.browser.post<Stage>(`/api/lists/${s.tarefas}/stages`, {
      name: 'Bloqueado',
      kind: 'active',
    })
  ).body;
  stages = (await s.owner.browser.get<Stage[]>(`/api/lists/${s.tarefas}/stages`)).body;
  first = stages[0] ?? blocked;
  await s.owner.browser.put(`/api/users/${s.marta.id}/capabilities`, {
    capabilities: ['users.manage', 'devices.approve', 'automations.manage'],
  });
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('setting who may put items into a stage', () => {
  it('is for whoever manages the list, from managers up, or nobody in particular', async () => {
    expect(blocked.entryRole).toBeNull();
    expect((await restrict(blocked, 'admin')).body.entryRole).toBe('admin');
    // Other changes leave it as it was.
    expect(
      (await s.owner.browser.patch<Stage>(`/api/stages/${blocked.id}`, { color: '#cc4444' })).body
        .entryRole,
    ).toBe('admin');
    expect((await restrict(blocked, 'employee')).status).toBe(400);
    expect(
      (await s.ana.browser.patch(`/api/stages/${blocked.id}`, { entryRole: null })).status,
    ).toBe(403);
    const made = await s.owner.browser.post<Stage>(`/api/lists/${s.tarefas}/stages`, {
      name: 'Aprovado',
      entryRole: 'owner',
    });
    expect(made.body.entryRole).toBe('owner');
    await s.owner.browser.delete(`/api/stages/${made.body.id}`);
    // Straight at the database, too.
    const refused = await env.admin
      .query(`UPDATE app.list_stages SET entry_role = 'employee' WHERE id = $1`, [blocked.id])
      .then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
    expect(refused).toBe('23514');
  });
});

describe('putting items into a restricted stage', () => {
  it('is refused below the role, on every path, and the item stays where it was', async () => {
    const hers = s.itemAna;
    const before = await stageOf(hers);
    const moved = await moveTo(s.ana, hers, blocked.id);
    expect(moved.status).toBe(403);
    expect(moved.body.error.code).toBe('stage_restricted');
    expect(await stageOf(hers)).toBe(before);

    const created = await s.ana.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/items`, {
      title: 'Direto no bloqueado',
      stageId: blocked.id,
    });
    expect(created.body.error.code).toBe('stage_restricted');

    // Marta is an ADM: she may; and so may the owner.
    expect((await moveTo(s.marta, s.itemNobody, blocked.id)).status).toBe(200);
    expect((await moveTo(s.owner, s.itemBruno, blocked.id)).status).toBe(200);
    // Taking an item out is not restricted.
    expect((await moveTo(s.bruno, s.itemBruno, first.id)).status).toBe(200);

    // At the database, as the API's own role, the same.
    expect(await bind(app, s.ana)).toBe(true);
    const direct = await attempt(app, 'UPDATE app.items SET stage_id = $1 WHERE id = $2', [
      blocked.id,
      hers,
    ]);
    expect(direct).toMatchObject({ ok: false, code: 'CB004' });
    const inserted = await attempt(
      app,
      `INSERT INTO app.items (id, list_id, title, stage_id)
       VALUES (gen_random_uuid(), $1, 'Por baixo', $2)`,
      [s.tarefas, blocked.id],
    );
    expect(inserted).toMatchObject({ ok: false, code: 'CB004' });
    await app.query('ROLLBACK');

    // Maintenance by the database owner is not a person moving items.
    await env.admin.query('UPDATE app.items SET stage_id = $1 WHERE id = $2', [blocked.id, hers]);
    expect(await stageOf(hers)).toBe(blocked.id);
    await env.admin.query('UPDATE app.items SET stage_id = $1 WHERE id = $2', [before, hers]);
  });

  it('lets an item land in a restricted first stage on its own', async () => {
    expect((await restrict(first, 'owner')).status).toBe(200);
    const made = await s.ana.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
      title: 'Cai na primeira',
    });
    expect(made.status).toBe(200);
    expect(made.body.stageId).toBe(first.id);
    // But choosing it is entering it.
    const chosen = await s.ana.browser.post<ErrorBody>(`/api/lists/${s.tarefas}/items`, {
      title: 'Escolhe a primeira',
      stageId: first.id,
    });
    expect(chosen.body.error.code).toBe('stage_restricted');
    // An item moved to another list without a stage chosen lands on its first stage.
    const perfisFirst = (await s.owner.browser.get<Stage[]>(`/api/lists/${s.perfis}/stages`))
      .body[0];
    await s.owner.browser.patch(`/api/stages/${perfisFirst?.id ?? ''}`, { entryRole: 'owner' });
    const traveller = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, { title: 'De mudança' })
    ).body.id;
    const moved = await s.marta.browser.post<Item>(`/api/items/${traveller}/move`, {
      listId: s.perfis,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.stageId).toBe(perfisFirst?.id);
    // Choosing it there is entering it.
    const back = await s.marta.browser.post<ErrorBody>(`/api/items/${s.itemNobody}/move`, {
      listId: s.perfis,
      stageId: perfisFirst?.id,
    });
    expect(back.body.error.code).toBe('stage_restricted');
    await restrict(first, null);
  });

  it('holds for a rule, which acts with no more than its author', async () => {
    const done = stages.find((stage) => stage.kind === 'done') ?? first;
    // Marta (ADM) writes a rule that blocks finished items; owners only may block.
    await restrict(blocked, 'owner');
    const rule = await s.marta.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/automations`, {
      name: 'Feito vai para bloqueado',
      trigger: { on: 'stage', to: done.id },
      actions: [
        { do: 'priority', to: 1 },
        { do: 'stage', to: blocked.id },
      ],
    });
    expect(rule.status).toBe(200);
    const id = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, {
        title: 'Termina',
      })
    ).body.id;
    expect((await moveTo(s.owner, id, done.id)).status).toBe(200);
    expect(await stageOf(id)).toBe(done.id);
    const runs = (
      await s.marta.browser.get<{ outcome: string; detail: string }[]>(
        `/api/automations/${rule.body.id}/runs`,
      )
    ).body;
    expect(runs[0]).toMatchObject({ outcome: 'failed', detail: 'CB004' });
    await restrict(blocked, 'admin');
  });
});
