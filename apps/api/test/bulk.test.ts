import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * Changing several items at once: all or nothing, only what the person may
 * change. Several to the trash at once is a critical action, by the API and
 * at the database: the capability, a recent code, the record, the alert.
 */

interface ErrorBody {
  error: { code: string };
}
interface Item {
  id: string;
  stageId: string;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let stages: { id: string }[];

const bulk = (person: Person, body: Record<string, unknown>) =>
  person.browser.post<{ changed: number } & ErrorBody>(`/api/lists/${s.tarefas}/bulk`, body);
const newItem = async (title: string): Promise<string> =>
  (await s.owner.browser.post<{ id: string }>(`/api/lists/${s.tarefas}/items`, { title })).body.id;
const trashed = async (ids: string[]): Promise<number> =>
  (
    await env.admin.query(
      `SELECT 1 FROM app.items WHERE id = ANY ($1::uuid[]) AND deleted_at IS NOT NULL`,
      [ids],
    )
  ).rowCount ?? 0;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  stages = (await s.owner.browser.get<{ id: string }[]>(`/api/lists/${s.tarefas}/stages`)).body;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('changing several items at once', () => {
  it('moves them all to a stage, or none when one is not the caller’s', async () => {
    const second = stages[1]?.id ?? '';
    const both = [s.itemNobody, s.itemBruno];
    expect((await bulk(s.marta, { action: 'stage', ids: both, stageId: second })).body).toEqual({
      changed: 2,
    });
    const items = (await s.marta.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
    expect(
      items.filter((item) => both.includes(item.id)).every((item) => item.stageId === second),
    ).toBe(true);
    // Ana edits only her own: one that is not hers refuses the whole change.
    const first = stages[0]?.id ?? '';
    const mixed = await bulk(s.ana, {
      action: 'stage',
      ids: [s.itemAna, s.itemBruno],
      stageId: first,
    });
    expect(mixed.body.error.code).toBe('invalid_selection');
    const stageOfAna = (await s.ana.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
      (item) => item.id === s.itemAna,
    )?.stageId;
    expect(stageOfAna).toBe(first);
    const elsewhere = await bulk(s.marta, { action: 'stage', ids: both, stageId: s.dinheiro });
    expect(elsewhere.body.error.code).toBe('invalid_stage');
  });

  it('sends several to the trash only with the capability and a recent code', async () => {
    const ids = [await newItem('Lote 1'), await newItem('Lote 2')];
    // Marta manages the list but was not given the capability.
    const refused = await bulk(s.marta, { action: 'trash', ids });
    expect(refused.status).toBe(403);
    expect(await trashed(ids)).toBe(0);
    await expireStepUp(env, s.owner);
    const stale = await bulk(s.owner, { action: 'trash', ids });
    expect(stale.body.error.code).toBe('step_up_required');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect((await bulk(s.owner, { action: 'trash', ids })).body).toEqual({ changed: 2 });
    expect(await trashed(ids)).toBe(2);
    const record = await env.admin.query<{ metadata: unknown }>(
      `SELECT metadata FROM audit.log WHERE action = 'items.bulk_trashed' ORDER BY seq DESC LIMIT 1`,
    );
    expect(record.rows[0]?.metadata).toEqual({ count: 2 });
    const alert = await env.admin.query(
      `SELECT severity FROM app.security_alerts WHERE kind = 'bulk_delete' AND actor_user_id = $1`,
      [s.owner.id],
    );
    expect(alert.rows).toEqual([{ severity: 'warning' }]);
  });

  it('passes several to a person who can work in the list, by who hands out work', async () => {
    const ids = [await newItem('Entrega 1'), await newItem('Entrega 2')];
    // Ana sees only her own items: she does not hand out work.
    const notHers = await bulk(s.ana, { action: 'assign', ids, userId: s.ana.id });
    expect(notHers.status).toBe(403);
    // Nuno cannot work in this list.
    const outsider = await bulk(s.marta, { action: 'assign', ids, userId: s.nuno.id });
    expect(outsider.body.error.code).toBe('cannot_assign_person');
    const elsewhere = await bulk(s.marta, {
      action: 'assign',
      ids: [ids[0], s.itemMoney],
      userId: s.ana.id,
    });
    expect(elsewhere.body.error.code).toBe('invalid_selection');
    expect(
      (await bulk(s.marta, { action: 'assign', ids: [...ids, s.itemAna], userId: s.ana.id })).body,
    ).toEqual({ changed: 2 });
    const hers = (await s.ana.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
    expect(ids.every((id) => hers.some((item) => item.id === id))).toBe(true);
    const record = await env.admin.query(
      `SELECT target_id, metadata FROM audit.log WHERE action = 'items.bulk_assigned'`,
    );
    expect(record.rows).toEqual([
      { target_id: s.tarefas, metadata: { user_id: s.ana.id, count: 2 } },
    ]);
  });

  it('sends one to the trash like the single button, without the capability', async () => {
    const one = await newItem('Só um');
    expect((await bulk(s.marta, { action: 'trash', ids: [one] })).body).toEqual({ changed: 1 });
  });
});

describe('straight at the database', () => {
  it('several to the trash need the capability and a recent code, even one statement at a time', async () => {
    const ids = [await newItem('Banco 1'), await newItem('Banco 2'), await newItem('Banco 3')];
    expect(await bind(app, s.marta)).toBe(true);
    const together = await attempt(
      app,
      `UPDATE app.items SET deleted_at = now() WHERE id = ANY ($1::uuid[])`,
      [ids],
    );
    expect(together).toMatchObject({ ok: false, code: 'CB001' });
    // One by one in the same request is counted together.
    const first = await attempt(app, `UPDATE app.items SET deleted_at = now() WHERE id = $1`, [
      ids[0],
    ]);
    expect(first.ok).toBe(true);
    const second = await attempt(app, `UPDATE app.items SET deleted_at = now() WHERE id = $1`, [
      ids[1],
    ]);
    expect(second).toMatchObject({ ok: false, code: 'CB001' });
    await app.query('ROLLBACK');

    await expireStepUp(env, s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    const stale = await attempt(
      app,
      `UPDATE app.items SET deleted_at = now() WHERE id = ANY ($1::uuid[])`,
      [ids],
    );
    expect(stale).toMatchObject({ ok: false, code: 'CB002' });
    await app.query('ROLLBACK');
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect(await trashed(ids)).toBe(0);
  });
});
