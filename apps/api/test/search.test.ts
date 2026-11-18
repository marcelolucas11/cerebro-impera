import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patternsOf } from '../src/modules/search.js';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Global search finds only what the person could open anyway: their own items
 * for an employee, nothing in a sensitive list without a recent code, nothing
 * in the trash. And "acao" finds "Ação".
 */

interface Hit {
  id: string;
  title: string;
  listName: string;
  inTitle: boolean;
}

let env: TestEnv;
let s: Scenario;

const find = async (person: Person, q: string): Promise<Hit[]> => {
  const response = await person.browser.get<Hit[]>(`/api/search?q=${encodeURIComponent(q)}`);
  expect(response.status, q).toBe(200);
  return response.body;
};
const titles = (hits: Hit[]): string[] => hits.map((hit) => hit.title).sort();

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
});
afterAll(async () => {
  await env.close();
});

describe('searching everywhere', () => {
  it('finds for each person only what they could open', async () => {
    expect(titles(await find(s.marta, 'tarefa'))).toEqual([
      'Tarefa da Ana',
      'Tarefa do Bruno',
      'Tarefa sem dono',
    ]);
    expect(titles(await find(s.ana, 'tarefa'))).toEqual(['Tarefa da Ana']);
    expect(await find(s.nuno, 'tarefa')).toEqual([]);
  });

  it('ignores case and accents, and every word must be there', async () => {
    await s.owner.browser.post(`/api/lists/${s.tarefas}/items`, { title: 'Revisar AÇÃO de março' });
    expect(titles(await find(s.marta, 'acao marco'))).toEqual(['Revisar AÇÃO de março']);
    expect(await find(s.marta, 'acao abril')).toEqual([]);
  });

  it('finds words in the description too, after the titles', async () => {
    await s.owner.browser.patch(`/api/items/${s.itemNobody}`, {
      description: 'Ligar para o fornecedor de embalagens',
    });
    const hits = await find(s.marta, 'embalagens');
    expect(hits).toMatchObject([{ id: s.itemNobody, inTitle: false }]);
  });

  it('does not search a sensitive list without a recent code, nor the trash', async () => {
    expect(titles(await find(s.owner, 'conta principal'))).toEqual(['Conta principal']);
    await expireStepUp(env, s.owner);
    expect(await find(s.owner, 'conta principal')).toEqual([]);
    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    await s.marta.browser.post(`/api/items/${s.itemBruno}/trash`);
    expect(titles(await find(s.marta, 'tarefa'))).not.toContain('Tarefa do Bruno');
  });

  it('reads what is typed literally, and refuses too little or too much', async () => {
    expect(patternsOf('50% a_b \\x')).toEqual(['%50\\%%', '%a\\_b%', '%\\\\x%']);
    expect(await find(s.marta, '%%')).toEqual([]);
    expect((await s.marta.browser.get('/api/search?q=a')).status).toBe(400);
    expect((await s.marta.browser.get(`/api/search?q=${'x'.repeat(101)}`)).status).toBe(400);
  });
});
