import { STAGE_PRESETS } from '@cerebro/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Bringing a whole set of stages into a list: from a preset, another list or a
 * file. Nothing is ever removed this way, and only whoever manages the list
 * may do it.
 */

interface ErrorBody {
  error: { code: string };
}
interface Stage {
  id: string;
  name: string;
  color: string;
  kind: string;
}

let env: TestEnv;
let s: Scenario;
let list: string;

const stagesOf = async (id: string): Promise<Stage[]> =>
  (await s.owner.browser.get<Stage[]>(`/api/lists/${id}/stages`)).body;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  list = (
    await s.owner.browser.post<{ id: string }>('/api/lists', {
      spaceId: s.operacao,
      name: 'Clientes',
    })
  ).body.id;
});
afterAll(async () => {
  await env.close();
});

describe('applying a set of stages', () => {
  it('creates what is missing, updates what shares a name, and puts the set first', async () => {
    const before = await stagesOf(list);
    expect(before.map((stage) => stage.name)).toEqual(['A fazer', 'Fazendo', 'Feito']);
    const item = await s.owner.browser.post<{ id: string; stageId: string }>(
      `/api/lists/${list}/items`,
      { title: 'Cliente em andamento', stageId: before[1]?.id },
    );

    const applied = await s.marta.browser.post<Stage[]>(`/api/lists/${list}/stages/apply`, {
      stages: [
        { name: 'Contato', color: '#9ba6b8', kind: 'open' },
        { name: 'FAZENDO', color: '#8FB8FF', kind: 'active' },
        { name: 'Encerrado', color: '#ef7b6a', kind: 'closed' },
      ],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.map((stage) => [stage.name, stage.color, stage.kind])).toEqual([
      ['Contato', '#9ba6b8', 'open'],
      // Same stage, same name as before: only its color and meaning follow the set.
      ['Fazendo', '#8fb8ff', 'active'],
      ['Encerrado', '#ef7b6a', 'closed'],
      ['A fazer', '#9ba6b8', 'open'],
      ['Feito', '#58b98a', 'done'],
    ]);
    // The item did not move: its stage is still there, with its own id.
    expect(applied.body[1]?.id).toBe(before[1]?.id);
    const items = await s.owner.browser.get<{ id: string; stageId: string }[]>(
      `/api/lists/${list}/items`,
    );
    expect(items.body.find((i) => i.id === item.body.id)?.stageId).toBe(before[1]?.id);
  });

  it('can take every preset as it is', async () => {
    for (const preset of STAGE_PRESETS) {
      const target = (
        await s.owner.browser.post<{ id: string }>('/api/lists', {
          spaceId: s.operacao,
          name: `Modelo ${preset.name}`,
        })
      ).body.id;
      const applied = await s.owner.browser.post<Stage[]>(`/api/lists/${target}/stages/apply`, {
        stages: preset.stages,
      });
      expect(applied.status, preset.name).toBe(200);
      expect(applied.body.slice(0, preset.stages.length).map((stage) => stage.name)).toEqual(
        preset.stages.map((stage) => stage.name),
      );
    }
  });

  it('is only for whoever manages the list', async () => {
    const body = { stages: [{ name: 'Invadida', color: '#9ba6b8', kind: 'open' }] };
    expect((await s.ana.browser.post(`/api/lists/${s.tarefas}/stages/apply`, body)).status).toBe(
      403,
    );
    expect((await s.nuno.browser.post(`/api/lists/${s.tarefas}/stages/apply`, body)).status).toBe(
      404,
    );
    expect((await s.marta.browser.post(`/api/lists/${s.dinheiro}/stages/apply`, body)).status).toBe(
      404,
    );
    expect((await stagesOf(s.tarefas)).map((stage) => stage.name)).not.toContain('Invadida');
  });

  it('refuses a set that is malformed or would pass the limit', async () => {
    const bad: unknown[] = [
      [],
      [{ name: 'A', color: 'azul', kind: 'open' }],
      [{ name: 'A', color: '#9ba6b8', kind: 'pronto' }],
      [{ name: 'A', color: '#9ba6b8' }],
      [
        { name: 'Igual', color: '#9ba6b8', kind: 'open' },
        { name: 'igual', color: '#9ba6b8', kind: 'open' },
      ],
      [{ name: 'A', color: '#9ba6b8', kind: 'open', id: 'x' }],
    ];
    for (const stages of bad) {
      const response = await s.owner.browser.post(`/api/lists/${list}/stages/apply`, { stages });
      expect(response.status, JSON.stringify(stages)).toBe(400);
    }
    const many = Array.from({ length: 36 }, (_, index) => ({
      name: `Etapa ${index + 1}`,
      color: '#9ba6b8',
      kind: 'active',
    }));
    const tooMany = await s.owner.browser.post<ErrorBody>(`/api/lists/${list}/stages/apply`, {
      stages: many,
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe('too_many_stages');
    expect(await stagesOf(list)).toHaveLength(5);
  });
});
