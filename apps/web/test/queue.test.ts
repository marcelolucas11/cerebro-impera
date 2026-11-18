import { describe, expect, it } from 'vitest';
import type { Item } from '../src/api.js';
import {
  applied,
  conflictText,
  enqueue,
  expectationOf,
  queueable,
  type QueuedChange,
} from '../src/offline/queue.js';

const item = {
  id: 'i1',
  listId: 'l1',
  title: 'Conferir perfis',
  stageId: 's-fazendo',
  priority: 2,
  dueDate: '2026-11-20',
} as Item;

const entry = (over: Partial<QueuedChange>): QueuedChange => ({
  id: 'q1',
  itemId: 'i1',
  listId: 'l1',
  itemTitle: 'Conferir perfis',
  change: { stageId: 's-feito' },
  expected: { stageId: 's-fazendo' },
  stageNames: { 's-fazendo': 'Fazendo', 's-feito': 'Feito', 's-bloq': 'Bloqueado' },
  madeAt: 0,
  state: 'waiting',
  ...over,
});

describe('a change made without a connection', () => {
  it('waits only for the plain facts of an item', () => {
    expect(queueable({ stageId: 'x' })).toBe(true);
    expect(queueable({ title: 'a', priority: null, dueDate: null })).toBe(true);
    expect(queueable({})).toBe(false);
    expect(queueable({ description: 'texto' })).toBe(false);
    expect(queueable({ stageId: 'x', fields: {} })).toBe(false);
    expect(queueable({ parentId: null })).toBe(false);
  });

  it('carries what was seen of what it changes, and the item reads with it', () => {
    expect(expectationOf(item, { stageId: 's-feito', priority: null })).toEqual({
      stageId: 's-fazendo',
      priority: 2,
    });
    expect(applied(item, { stageId: 's-feito' })).toMatchObject({
      stageId: 's-feito',
      title: 'Conferir perfis',
    });
  });

  it('joins a later change to the same item, keeping what was first seen', () => {
    const first = entry({});
    const queue = enqueue(
      [first],
      entry({
        id: 'q2',
        change: { stageId: 's-bloq', title: 'Outro' },
        expected: { stageId: 's-feito', title: 'Conferir perfis' },
      }),
    );
    expect(queue).toHaveLength(1);
    expect(queue[0]?.change).toEqual({ stageId: 's-bloq', title: 'Outro' });
    expect(queue[0]?.expected).toEqual({ stageId: 's-fazendo', title: 'Conferir perfis' });
    // A decided one is not joined: the new change waits on its own.
    expect(enqueue([entry({ state: 'conflict' })], entry({ id: 'q2' }))).toHaveLength(2);
  });

  it('says a conflict in words, with stage names and days as people write them', () => {
    expect(conflictText(entry({ state: 'conflict', current: { stageId: 's-bloq' } }))).toBe(
      'na etapa, a sua é Feito e a de lá é Bloqueado',
    );
    expect(
      conflictText(
        entry({
          change: { dueDate: '2026-11-21', priority: null },
          state: 'conflict',
          current: { dueDate: '2026-11-25', priority: 1 },
        }),
      ),
    ).toBe(
      'na prioridade, a sua é vazio e a de lá é 1; no prazo, a sua é 21/11/2026 e a de lá é 25/11/2026',
    );
  });
});
