import { describe, expect, it } from 'vitest';
import type { ItemChange } from '../src/api.js';
import type { FieldLike } from '../src/fieldvalues.js';
import { describeChange, type HistoryContext } from '../src/history.js';

const ME = 'me';
const ANA = 'ana';
const OPTION = '11111111-1111-4111-8111-111111111111';
const fields: Record<string, FieldLike> = {
  valor: { id: 'valor', name: 'Valor', kind: 'money', config: { currency: 'BRL' } },
  fornecedor: {
    id: 'fornecedor',
    name: 'Fornecedor',
    kind: 'select',
    config: { options: [{ id: OPTION, name: 'Alfa', color: '#58b98a' }] },
  },
};
const context: HistoryContext = {
  nameOf: (id) =>
    id === null ? 'sistema' : id === ME ? 'você' : id === ANA ? 'Ana' : 'outra pessoa',
  fieldOf: (id) => fields[id],
  listNameOf: (id) => (id === 'tarefas' ? 'Tarefas' : undefined),
};
const change = (partial: Partial<ItemChange>): ItemChange => ({
  id: 1,
  at: '2026-11-17T12:00:00Z',
  actor: ME,
  what: 'created',
  fieldId: null,
  old: null,
  new: null,
  ...partial,
});
const say = (partial: Partial<ItemChange>): string =>
  describeChange(change(partial), context).sentence;
const plain = (text: string): string => text.replace(/\s/g, ' ');

describe('a line of an item’s history', () => {
  it('says who did what, in a sentence', () => {
    expect(say({ what: 'created', new: { title: 'X' } })).toBe('Você criou o item');
    expect(say({ what: 'created', actor: null })).toBe('Sistema criou o item');
    expect(say({ what: 'title', actor: ANA, old: 'Antes', new: 'Depois' })).toBe(
      'Ana mudou o título de “Antes” para “Depois”',
    );
    expect(
      say({ what: 'stage', old: { id: 'a', name: 'A fazer' }, new: { id: 'b', name: 'Feito' } }),
    ).toBe('Você moveu de A fazer para Feito');
  });

  it('tells handing over from taking on, and leaving from being taken off', () => {
    expect(say({ what: 'assigned', new: ANA })).toBe('Você passou o item para Ana');
    expect(say({ what: 'assigned', actor: ANA, new: ANA })).toBe('Ana ficou com o item');
    expect(say({ what: 'unassigned', old: ANA })).toBe('Você tirou Ana do item');
    expect(say({ what: 'unassigned', actor: ANA, old: ANA })).toBe('Ana saiu do item');
    // Someone this person cannot see is not named.
    expect(say({ what: 'assigned', new: 'someone' })).toBe('Você passou o item para outra pessoa');
  });

  it('keeps an earlier description out of the way, without losing it', () => {
    const first = describeChange(change({ what: 'description', old: '', new: 'Texto' }), context);
    expect(first).toEqual({ sentence: 'Você escreveu a descrição' });
    const later = describeChange(
      change({ what: 'description', old: 'Texto antigo', new: 'Texto novo' }),
      context,
    );
    expect(later).toEqual({ sentence: 'Você alterou a descrição', before: 'Texto antigo' });
  });

  it('names only the lists this person can open', () => {
    expect(say({ what: 'list', old: 'tarefas', new: 'escondida' })).toBe(
      'Você moveu o item de Tarefas para outra lista',
    );
  });

  it('shows field values the way they are read on the list', () => {
    expect(plain(say({ what: 'field', fieldId: 'valor', new: 149_990 }))).toBe(
      'Você preencheu Valor: R$ 1.499,90',
    );
    expect(plain(say({ what: 'field', fieldId: 'valor', old: 100, new: 250 }))).toBe(
      'Você mudou Valor de R$ 1,00 para R$ 2,50',
    );
    expect(plain(say({ what: 'field', fieldId: 'valor', old: 100 }))).toBe(
      'Você limpou Valor (era R$ 1,00)',
    );
    expect(say({ what: 'field', fieldId: 'fornecedor', new: OPTION })).toBe(
      'Você preencheu Fornecedor: Alfa',
    );
    // A field this screen no longer knows is mentioned without its contents.
    expect(say({ what: 'field', fieldId: 'arquivado', new: 'segredo' })).toBe(
      'Você alterou um campo',
    );
  });
});
