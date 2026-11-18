import { describe, expect, it } from 'vitest';
import type { Item } from '../src/api.js';
import type { FieldLike } from '../src/fieldvalues.js';
import {
  DEFAULT_SORT,
  fromSearch,
  isFiltering,
  matches,
  NO_FILTER,
  plain,
  sortItems,
  testsFor,
  toSearch,
  type Filter,
} from '../src/filters.js';

const ME = 'me';
const ANA = 'ana';
const ALFA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';

const fields: FieldLike[] = [
  {
    id: 'fornecedor',
    name: 'Fornecedor',
    kind: 'select',
    config: {
      options: [
        { id: BETA, name: 'Beta', color: '#dba63f' },
        { id: ALFA, name: 'Alfa', color: '#58b98a' },
      ],
    },
  },
  { id: 'valor', name: 'Valor', kind: 'money', config: { currency: 'BRL' } },
  { id: 'entrega', name: 'Entrega', kind: 'date', config: {} },
  { id: 'obs', name: 'Observação', kind: 'text', config: {} },
  { id: 'senha', name: 'Senha', kind: 'secret', config: {} },
  { id: 'pronto', name: 'Pronto', kind: 'checkbox', config: {} },
];

let counter = 0;
function item(partial: Partial<Item>): Item {
  counter += 1;
  return {
    id: `item-${String(counter).padStart(3, '0')}`,
    listId: 'lista',
    title: 'Sem título',
    description: '',
    createdBy: ME,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    assignees: [],
    stageId: 'a-fazer',
    stageSince: '2026-11-01T00:00:00Z',
    fields: {},
    secrets: [],
    trashedAt: null,
    trashedBy: null,
    ...partial,
  };
}

const context = { me: ME, fields };
const only = (items: Item[], filter: Partial<Filter>): string[] =>
  items.filter((one) => matches(one, { ...NO_FILTER, ...filter }, context)).map((one) => one.title);

const campanha = item({
  title: 'Subir campanha de Ação',
  assignees: [ANA],
  fields: { fornecedor: ALFA, valor: 149_990, entrega: '2026-11-20', obs: 'Cliente pediu PRESSA' },
  secrets: ['senha'],
});
const perfis = item({
  title: 'Conferir perfis',
  assignees: [ME],
  stageId: 'fazendo',
  fields: { fornecedor: BETA, valor: 25_000, pronto: true },
});
const solto = item({ title: 'Ligar para o cliente', fields: { entrega: '2026-12-01' } });
const all = [campanha, perfis, solto];

describe('searching titles', () => {
  it('finds every word, ignoring case and accents', () => {
    expect(plain('Ação Rápida')).toBe('acao rapida');
    expect(only(all, { text: 'acao' })).toEqual(['Subir campanha de Ação']);
    expect(only(all, { text: 'CLIENTE ligar' })).toEqual(['Ligar para o cliente']);
    expect(only(all, { text: 'campanha perfis' })).toEqual([]);
    expect(only(all, { text: '   ' })).toHaveLength(3);
  });
});

describe('filtering by who', () => {
  it('is mine, nobody’s, or a given person’s', () => {
    expect(only(all, { who: 'me' })).toEqual(['Conferir perfis']);
    expect(only(all, { who: 'nobody' })).toEqual(['Ligar para o cliente']);
    expect(only(all, { who: ANA })).toEqual(['Subir campanha de Ação']);
  });

  it('and by stage', () => {
    expect(only(all, { stageId: 'fazendo' })).toEqual(['Conferir perfis']);
  });
});

describe('filtering by a field', () => {
  const by = (id: string, test: NonNullable<Filter['field']>['test']) =>
    only(all, { field: { id, test } });

  it('asks each kind what makes sense for it', () => {
    expect(testsFor('select')).toEqual(['is', 'filled', 'empty']);
    expect(testsFor('money')).toContain('atLeast');
    expect(testsFor('date')).toContain('from');
    expect(testsFor('secret')).toEqual(['filled', 'empty']);
    expect(testsFor('text')).toContain('contains');
  });

  it('by option, text, amount in units and day', () => {
    expect(by('fornecedor', { op: 'is', value: ALFA })).toEqual(['Subir campanha de Ação']);
    expect(by('obs', { op: 'contains', value: 'pressa' })).toEqual(['Subir campanha de Ação']);
    expect(by('valor', { op: 'atLeast', value: 1000 })).toEqual(['Subir campanha de Ação']);
    expect(by('valor', { op: 'atMost', value: 250 })).toEqual(['Conferir perfis']);
    expect(by('entrega', { op: 'from', value: '2026-11-21' })).toEqual(['Ligar para o cliente']);
    expect(by('entrega', { op: 'until', value: '2026-11-20' })).toEqual(['Subir campanha de Ação']);
  });

  it('by being filled or empty, a secret by whether it is kept, a box by its tick', () => {
    expect(by('senha', { op: 'filled' })).toEqual(['Subir campanha de Ação']);
    expect(by('senha', { op: 'empty' })).toHaveLength(2);
    expect(by('pronto', { op: 'filled' })).toEqual(['Conferir perfis']);
    expect(by('entrega', { op: 'empty' })).toEqual(['Conferir perfis']);
  });

  it('a field that is gone hides nothing', () => {
    expect(by('arquivado', { op: 'filled' })).toHaveLength(3);
  });
});

describe('ordering', () => {
  const titles = (items: Item[]) => items.map((one) => one.title);

  it('by title, in the way people here alphabetize', () => {
    expect(titles(sortItems(all, { key: 'title', descending: false }, fields))).toEqual([
      'Conferir perfis',
      'Ligar para o cliente',
      'Subir campanha de Ação',
    ]);
  });

  it('by a field, with empty values last whichever the direction', () => {
    const up = sortItems(all, { key: 'field:valor', descending: false }, fields);
    expect(titles(up)).toEqual([
      'Conferir perfis',
      'Subir campanha de Ação',
      'Ligar para o cliente',
    ]);
    const down = sortItems(all, { key: 'field:valor', descending: true }, fields);
    expect(titles(down)).toEqual([
      'Subir campanha de Ação',
      'Conferir perfis',
      'Ligar para o cliente',
    ]);
  });

  it('by a choice field in the order its options were given', () => {
    const sorted = sortItems(all, { key: 'field:fornecedor', descending: false }, fields);
    expect(titles(sorted)).toEqual([
      'Conferir perfis',
      'Subir campanha de Ação',
      'Ligar para o cliente',
    ]);
  });

  it('by default, whoever has waited longest in their stage first', () => {
    const early = item({ title: 'Cedo', stageSince: '2026-10-01T00:00:00Z' });
    expect(titles(sortItems([...all, early], DEFAULT_SORT, fields))[0]).toBe('Cedo');
  });
});

describe('in the address', () => {
  it('goes out and comes back the same', () => {
    const filter: Filter = {
      text: 'campanha',
      who: ANA,
      stageId: 'fazendo',
      field: { id: 'valor', test: { op: 'atLeast', value: 100 } },
    };
    const sort = { key: 'field:valor' as const, descending: true };
    expect(fromSearch(toSearch(filter, sort))).toEqual({ filter, sort });
    expect(toSearch(NO_FILTER, DEFAULT_SORT)).toBe('');
    expect(isFiltering(NO_FILTER)).toBe(false);
    expect(isFiltering(filter)).toBe(true);
  });

  it('ignores what does not make sense instead of failing', () => {
    const odd = fromSearch('?teste=apagar&campo=x&ordem=senha&valor=abc');
    expect(odd.filter.field).toBeNull();
    expect(odd.sort).toEqual(DEFAULT_SORT);
    const notANumber = fromSearch('?campo=valor&teste=atLeast&valor=muito');
    expect(notANumber.filter.field).toBeNull();
  });
});
