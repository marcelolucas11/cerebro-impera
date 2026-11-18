import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * A change made without a connection travels with what the person saw before
 * making it. If someone else changed the same thing meanwhile, nothing is
 * written: the server answers with what is there now, and the person decides.
 */

interface Item {
  id: string;
  title: string;
  stageId: string;
  priority: number | null;
  dueDate: string | null;
}
interface Refusal {
  error: { code: string; details?: { current?: Record<string, unknown> } };
}

let env: TestEnv;
let s: Scenario;
let stages: { id: string; name: string }[];

const itemOf = async (id: string): Promise<Item> => {
  const items = (await s.owner.browser.get<Item[]>(`/api/lists/${s.tarefas}/items`)).body;
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new Error('item not found');
  return found;
};

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  stages = (
    await s.owner.browser.get<{ id: string; name: string }[]>(`/api/lists/${s.tarefas}/stages`)
  ).body;
});
afterAll(async () => {
  await env.close();
});

describe('a change made from what the person saw', () => {
  it('is written when nothing changed meanwhile', async () => {
    const before = await itemOf(s.itemAna);
    const target = stages.find((stage) => stage.id !== before.stageId)?.id ?? '';
    const response = await s.ana.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      stageId: target,
      title: 'Tarefa da Ana, revista',
      expected: { stageId: before.stageId, title: before.title, priority: null, dueDate: null },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ stageId: target, title: 'Tarefa da Ana, revista' });
  });

  it('is refused when someone else changed it, with what is there now, and nothing is written', async () => {
    const seen = await itemOf(s.itemAna);
    await s.owner.browser.patch(`/api/items/${s.itemAna}`, {
      title: 'Mudado pela Dona',
      priority: 2,
    });
    const response = await s.ana.browser.patch<Refusal>(`/api/items/${s.itemAna}`, {
      title: 'Mudado offline pela Ana',
      priority: 4,
      expected: { title: seen.title, priority: seen.priority, stageId: seen.stageId },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('changed_meanwhile');
    // Only what moved is told, and only of what she sent.
    expect(response.body.error.details?.current).toEqual({
      title: 'Mudado pela Dona',
      priority: 2,
    });
    expect(await itemOf(s.itemAna)).toMatchObject({ title: 'Mudado pela Dona', priority: 2 });

    // Keeping hers is sending it again without the expectation: both stay in the history.
    expect(
      (await s.ana.browser.patch(`/api/items/${s.itemAna}`, { title: 'Mudado offline pela Ana' }))
        .status,
    ).toBe(200);
    const history = (
      await s.owner.browser.get<{ what: string; new: unknown }[]>(`/api/items/${s.itemAna}/history`)
    ).body;
    const titles = history.filter((entry) => entry.what === 'title').map((entry) => entry.new);
    expect(titles).toEqual(expect.arrayContaining(['Mudado pela Dona', 'Mudado offline pela Ana']));
  });

  it('follows the usual rules: no access, no change and no hint of what is there', async () => {
    const response = await s.bruno.browser.patch<Refusal>(`/api/items/${s.itemAna}`, {
      title: 'Do Bruno',
      expected: { title: 'qualquer coisa' },
    });
    expect(response.status).toBe(404);
    expect(response.body.error.details).toBeUndefined();
  });

  it('needs a change: what was seen alone is not one', async () => {
    const response = await s.ana.browser.patch<Refusal>(`/api/items/${s.itemAna}`, {
      expected: { title: 'Mudado offline pela Ana' },
    });
    expect(response.status).toBe(400);
  });
});
