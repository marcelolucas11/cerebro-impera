import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Opening a list must not get slower with every row it has. The rules that
 * decide who sees what are evaluated by the database; written carelessly they
 * run once per row, and a list of a few hundred items takes seconds to open.
 * This keeps that from coming back unnoticed.
 */

interface Item {
  id: string;
  assignees: string[];
  fields: Record<string, unknown>;
}

const ITEMS = 500;
const FIELDS = 8;
/**
 * Far above what it takes when access is worked out once per statement (tens
 * of milliseconds), far below what it took once per row (over two seconds).
 */
const LIMIT_MS = 900;

let env: TestEnv;
let s: Scenario;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  for (let index = 0; index < FIELDS; index += 1) {
    const created = await s.owner.browser.post(`/api/lists/${s.tarefas}/fields`, {
      name: `Campo ${index + 1}`,
      kind: 'text',
    });
    expect(created.status).toBe(200);
  }
  // Bulk data goes in with the migrator's rights: the point here is reading it.
  await env.admin.query(
    `INSERT INTO app.items (id, list_id, title, created_by)
     SELECT gen_random_uuid(), $1, 'Item ' || n, $2 FROM generate_series(1, $3::int) n`,
    [s.tarefas, s.owner.id, ITEMS],
  );
  await env.admin.query(
    `INSERT INTO app.item_assignees (item_id, user_id, assigned_by)
     SELECT i.id, $2, $3 FROM app.items i WHERE i.list_id = $1 AND i.title LIKE 'Item %'`,
    [s.tarefas, s.ana.id, s.owner.id],
  );
  await env.admin.query(
    `INSERT INTO app.item_field_values (item_id, field_id, value, updated_by)
     SELECT i.id, f.id, to_jsonb('valor de ' || i.title), $2
     FROM app.items i JOIN app.list_fields f ON f.list_id = i.list_id
     WHERE i.list_id = $1 AND i.title LIKE 'Item %'`,
    [s.tarefas, s.owner.id],
  );
  await env.admin.query('ANALYZE');
}, 120_000);
afterAll(async () => {
  await env.close();
});

describe('a list of five hundred items, each with eight fields filled in', () => {
  it('opens quickly for an owner, a manager and an employee who sees only their own', async () => {
    for (const person of [s.owner, s.marta, s.ana]) {
      // The first request also pays for a cold connection; the second is the honest one.
      await person.browser.get(`/api/lists/${s.tarefas}/items`);
      const start = performance.now();
      const response = await person.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`);
      const elapsed = performance.now() - start;

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(ITEMS);
      expect(response.body.every((item) => Object.keys(item.fields).length === FIELDS)).toBe(true);
      expect(elapsed, `${person.id} waited ${Math.round(elapsed)} ms`).toBeLessThan(LIMIT_MS);
    }
  });

  it('still shows an employee nothing that is not theirs', async () => {
    const seen = await s.bruno.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`);
    expect(seen.body.map((item) => item.id)).toEqual([s.itemBruno]);
  });
});
