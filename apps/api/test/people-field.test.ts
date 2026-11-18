import { randomUUID } from 'node:crypto';
import { fieldValueProblem } from '@cerebro/shared';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * A field that names people. It may name only people who can work in the
 * item's list, by any path; someone named before keeps their place.
 */

interface ErrorBody {
  error: { code: string; details?: { problem?: string } };
}
interface Item {
  id: string;
  fields: Record<string, unknown>;
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let checkedBy: string;

const valueOn = async (item: string): Promise<unknown> =>
  (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body.find(
    (candidate) => candidate.id === item,
  )?.fields[checkedBy];

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const created = await s.owner.browser.post<{ id: string; config: unknown }>(
    `/api/lists/${s.tarefas}/fields`,
    { name: 'Conferido por', kind: 'people' },
  );
  expect(created.status).toBe(200);
  expect(created.body.config).toEqual({});
  checkedBy = created.body.id;
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('a people field', () => {
  it('names people who can work in the list', async () => {
    const saved = await s.marta.browser.patch<Item>(`/api/items/${s.itemNobody}`, {
      fields: { [checkedBy]: [s.ana.id, s.marta.id] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.fields[checkedBy]).toEqual([s.ana.id, s.marta.id]);
    // Ana names herself on her own item.
    const hers = await s.ana.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      fields: { [checkedBy]: [s.ana.id] },
    });
    expect(hers.status).toBe(200);
  });

  it('refuses anyone who cannot work in the list, and anything that is not a list of people', async () => {
    for (const nobody of [s.nuno.id, randomUUID()]) {
      const refused = await s.marta.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
        fields: { [checkedBy]: [s.ana.id, nobody] },
      });
      expect(refused.status).toBe(400);
    }
    const shapes: [unknown, string][] = [
      ['Ana', 'wrong_type'],
      [[], 'empty'],
      [[s.ana.id, s.ana.id], 'duplicate_person'],
      [Array.from({ length: 21 }, () => randomUUID()), 'too_many_people'],
    ];
    for (const [value, problem] of shapes) {
      const response = await s.marta.browser.patch<ErrorBody>(`/api/items/${s.itemNobody}`, {
        fields: { [checkedBy]: value },
      });
      expect(response.status, JSON.stringify(value)).toBe(400);
      if (problem !== 'wrong_type') expect(response.body.error.details?.problem).toBe(problem);
    }
    expect(await valueOn(s.itemNobody)).toEqual([s.ana.id, s.marta.id]);
  });

  it('keeps someone named before who can no longer work in the list, and adds no one new like them', async () => {
    const showcase = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.financeiro,
        name: 'Conferência',
      })
    ).body.id;
    const field = (
      await s.owner.browser.post<{ id: string }>(`/api/lists/${showcase}/fields/copy`, {
        fromListId: s.tarefas,
      })
    ).body as unknown as { created: { id: string }[] };
    const there = field.created[0]?.id ?? '';
    await s.owner.browser.put('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: showcase,
      level: 'edit',
      itemScope: 'all',
    });
    const item = (
      await s.owner.browser.post<Item>(`/api/lists/${showcase}/items`, {
        title: 'Conferido pelo Bruno',
        fields: { [there]: [s.bruno.id] },
      })
    ).body;
    expect(item.fields[there]).toEqual([s.bruno.id]);

    // Bruno loses access to that list.
    await env.admin.query('DELETE FROM app.access_grants WHERE user_id = $1 AND list_id = $2', [
      s.bruno.id,
      showcase,
    ]);
    const kept = await s.owner.browser.patch<Item>(`/api/items/${item.id}`, {
      fields: { [there]: [s.bruno.id, s.owner.id] },
    });
    expect(kept.status).toBe(200);
    const added = await s.owner.browser.patch(`/api/items/${item.id}`, {
      fields: { [there]: [s.owner.id] },
    });
    expect(added.status).toBe(200);
    const back = await s.owner.browser.patch(`/api/items/${item.id}`, {
      fields: { [there]: [s.owner.id, s.bruno.id] },
    });
    expect(back.status).toBe(400);
  });

  it('goes along with a moved item only when everyone named can work in the other list', async () => {
    const campanhas = (
      await s.owner.browser.post<{ id: string }>('/api/lists', {
        spaceId: s.operacao,
        name: 'Campanhas',
      })
    ).body.id;
    const copied = (
      await s.owner.browser.post<{ created: { id: string }[] }>(
        `/api/lists/${campanhas}/fields/copy`,
        { fromListId: s.tarefas, fieldIds: [checkedBy] },
      )
    ).body.created[0]?.id;
    // Ana has no access to Campanhas; Marta does (she manages the whole space).
    const withAna = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
        title: 'Com a Ana',
        fields: { [checkedBy]: [s.ana.id] },
      })
    ).body;
    const withMarta = (
      await s.owner.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
        title: 'Com a Marta',
        fields: { [checkedBy]: [s.marta.id] },
      })
    ).body;
    const movedAna = await s.owner.browser.post<Item>(`/api/items/${withAna.id}/move`, {
      listId: campanhas,
    });
    expect(movedAna.status).toBe(200);
    expect(movedAna.body.fields).toEqual({});
    const movedMarta = await s.owner.browser.post<Item>(`/api/items/${withMarta.id}/move`, {
      listId: campanhas,
    });
    expect(movedMarta.body.fields).toEqual({ [copied ?? '']: [s.marta.id] });
  });
});

describe('straight at the database', () => {
  it('nobody is named who cannot work in the list, by any path', async () => {
    expect(await bind(app, s.marta)).toBe(true);
    const nuno = await attempt(
      app,
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      [s.itemBruno, checkedBy, JSON.stringify([s.nuno.id])],
    );
    expect(nuno).toMatchObject({ ok: false, code: '23514' });
    const bruno = await attempt(
      app,
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      [s.itemBruno, checkedBy, JSON.stringify([s.bruno.id])],
    );
    expect(bruno).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('ROLLBACK');

    // Someone who may only look at the list cannot be named either.
    const granted = await s.owner.browser.put('/api/grants', {
      userId: s.nuno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'view',
      itemScope: 'all',
    });
    expect(granted.status).toBe(200);
    expect(await bind(app, s.marta)).toBe(true);
    const viewer = await attempt(
      app,
      `INSERT INTO app.item_field_values (item_id, field_id, value) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
      [s.itemBruno, checkedBy, JSON.stringify([s.nuno.id])],
    );
    expect(viewer).toMatchObject({ ok: false, code: '23514' });
    await app.query('ROLLBACK');
  });

  it('the database and the API agree on what a list of people looks like', async () => {
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    const cases: unknown[] = [
      [a],
      [a, b],
      [],
      [a, a],
      a,
      [a.toUpperCase()],
      ['ana'],
      [1],
      Array.from(
        { length: 20 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
      Array.from(
        { length: 21 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      ),
      null,
      { a },
    ];
    for (const value of cases) {
      const fromApi = fieldValueProblem('people', {}, value);
      const fromDb = await env.admin.query<{ problem: string | null }>(
        `SELECT app.field_value_problem('people', '{}'::jsonb, $1::jsonb, NULL) AS problem`,
        [JSON.stringify(value)],
      );
      expect(fromDb.rows[0]?.problem === null, JSON.stringify(value)).toBe(fromApi === null);
    }
  });
});
