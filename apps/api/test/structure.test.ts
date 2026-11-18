import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Who shapes the structure: owners anywhere; whoever manages a space or a
 * folder, inside it and nowhere else. The tree says where each person may
 * build, so the page offers exactly that.
 */

interface Tree {
  spaces: { id: string; name: string; canManage: boolean }[];
  folders: { id: string; spaceId: string; name: string; canManage: boolean }[];
  lists: { id: string; name: string; level: string }[];
}
interface ErrorBody {
  error: { code: string };
}

let env: TestEnv;
let s: Scenario;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
});
afterAll(async () => {
  await env.close();
});

describe('a space manager who is not an owner', () => {
  it('is told where they may build, and nowhere else', async () => {
    const marta = (await s.marta.browser.get<Tree>('/api/tree')).body;
    expect(marta.spaces.map(({ id, canManage }) => [id, canManage])).toEqual([[s.operacao, true]]);
    expect(marta.folders.every((folder) => folder.canManage)).toBe(true);
    const ana = (await s.ana.browser.get<Tree>('/api/tree')).body;
    expect(ana.spaces.every((space) => !space.canManage)).toBe(true);
    expect(ana.folders.every((folder) => !folder.canManage)).toBe(true);
    const owner = (await s.owner.browser.get<Tree>('/api/tree')).body;
    expect(owner.spaces.every((space) => space.canManage)).toBe(true);
  });

  it('creates folders and lists inside the space, and manages what they create', async () => {
    const folder = await s.marta.browser.post<{ id: string }>('/api/folders', {
      spaceId: s.operacao,
      name: 'Campanhas',
    });
    expect(folder.status).toBe(200);
    const list = await s.marta.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      folderId: folder.body.id,
      name: 'Calendário',
    });
    expect(list.status).toBe(200);
    const atRoot = await s.marta.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      name: 'Pedidos',
      isSensitive: true,
    });
    expect(atRoot.status).toBe(200);
    const tree = (await s.marta.browser.get<Tree>('/api/tree')).body;
    expect(tree.lists.find((one) => one.id === list.body.id)?.level).toBe('manage');
    expect(tree.folders.find((one) => one.id === folder.body.id)?.canManage).toBe(true);
    // A new list is born with stages, ready to use.
    const stages = await s.marta.browser.get<unknown[]>(`/api/lists/${list.body.id}/stages`);
    expect(stages.body.length).toBeGreaterThan(0);
  });

  it('cannot build outside it, nor create spaces', async () => {
    const elsewhere = await s.marta.browser.post<ErrorBody>('/api/lists', {
      spaceId: s.financeiro,
      name: 'Fora da área',
    });
    expect(elsewhere.status).toBe(404);
    const space = await s.marta.browser.post<ErrorBody>('/api/spaces', { name: 'Próprio' });
    expect(space.status).toBe(403);
  });
});

describe('someone who works in a list', () => {
  it('builds nothing around it', async () => {
    const folder = await s.ana.browser.post<ErrorBody>('/api/folders', {
      spaceId: s.operacao,
      name: 'Minha pasta',
    });
    expect(folder.status).toBe(403);
    const list = await s.ana.browser.post<ErrorBody>('/api/lists', {
      spaceId: s.operacao,
      folderId: s.equipe,
      name: 'Minha lista',
    });
    expect(list.status).toBe(403);
  });
});
