import { describe, expect, it } from 'vitest';
import type { Item } from '../src/api.js';
import type { FieldLike } from '../src/fieldvalues.js';
import {
  DEFAULT_SORT,
  defaultColumns,
  groupItems,
  fromSearch,
  isFiltering,
  matches,
  nestSubtasks,
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
    position: null,
    priority: null,
    startDate: null,
    dueDate: null,
    parentId: null,
    checks: { done: 0, total: 0 },
    trashedAt: null,
    trashedBy: null,
    ...partial,
  };
}

const context = { me: ME, fields, today: '2026-11-18', finished: new Set(['feito']) };
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

  it('by default, cards placed by hand first in their places, then whoever waited longest', () => {
    const placedByHand = (title: string, position: number) => ({ ...item({ title }), position });
    const sorted = sortItems(
      [
        item({ title: 'Sem lugar, recente', stageSince: '2026-11-10T00:00:00Z' }),
        placedByHand('Segundo', 2048),
        item({ title: 'Sem lugar, antigo', stageSince: '2026-10-10T00:00:00Z' }),
        placedByHand('Primeiro', 1024),
      ],
      DEFAULT_SORT,
      fields,
    );
    expect(titles(sorted)).toEqual([
      'Primeiro',
      'Segundo',
      'Sem lugar, antigo',
      'Sem lugar, recente',
    ]);
  });

  it('by time in stage, when asked, whoever has waited longest first', () => {
    const early = item({ title: 'Cedo', stageSince: '2026-10-01T00:00:00Z' });
    const byStage = { key: 'stage' as const, descending: false };
    expect(titles(sortItems([...all, early], byStage, fields))[0]).toBe('Cedo');
  });
});

describe('in the address', () => {
  it('goes out and comes back the same', () => {
    const filter: Filter = {
      text: 'campanha',
      who: ANA,
      stageId: 'fazendo',
      field: { id: 'valor', test: { op: 'atLeast', value: 100 } },
      priority: '2',
      due: 'overdue',
    };
    const sort = { key: 'field:valor' as const, descending: true };
    expect(fromSearch(toSearch(filter, sort))).toEqual({
      filter,
      sort,
      columns: null,
      group: 'stage',
    });
    const columns = ['etapa', 'valor', 'responsaveis'];
    expect(fromSearch(toSearch(filter, sort, columns)).columns).toEqual(columns);
    expect(fromSearch(toSearch(NO_FILTER, DEFAULT_SORT, [])).columns).toEqual([]);
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
    expect(fromSearch('?colunas=etapa,<b>,etapa,ok-1').columns).toEqual(['etapa', 'ok-1']);
    const strange = fromSearch('?prioridade=9&prazo=ontem');
    expect(strange.filter).toMatchObject({ priority: 'any', due: 'any' });
    expect(fromSearch('?prioridade=none&prazo=week&ordem=due').filter).toMatchObject({
      priority: 'none',
      due: 'week',
    });
    expect(fromSearch('?ordem=due').sort.key).toBe('due');
  });
});

describe('priority and due dates', () => {
  // Today is 2026-11-18 in these tests; "feito" is a finished stage.
  const late = item({ title: 'Atrasado', dueDate: '2026-11-17', priority: 1 });
  const lateButDone = item({ title: 'Feito atrasado', dueDate: '2026-11-10', stageId: 'feito' });
  const today = item({ title: 'Hoje', dueDate: '2026-11-18', priority: 3 });
  const soon = item({ title: 'Domingo', dueDate: '2026-11-24', priority: 2 });
  const later = item({ title: 'Depois', dueDate: '2026-11-25' });
  const none = item({ title: 'Sem prazo', priority: 4 });
  const all = [late, lateButDone, today, soon, later, none];
  const titles = (items: Item[]) => items.map((one) => one.title);

  it('filters by priority, or by having none', () => {
    expect(only(all, { priority: '1' })).toEqual(['Atrasado']);
    expect(only(all, { priority: 'none' })).toEqual(['Feito atrasado', 'Depois']);
  });

  it('filters what is late, due today, due within a week, or has no due date', () => {
    // Late means past due and still open: a finished item is not late.
    expect(only(all, { due: 'overdue' })).toEqual(['Atrasado']);
    expect(only(all, { due: 'today' })).toEqual(['Hoje']);
    // Today and the next six days.
    expect(only(all, { due: 'week' })).toEqual(['Hoje', 'Domingo']);
    expect(only(all, { due: 'none' })).toEqual(['Sem prazo']);
    expect(isFiltering({ ...NO_FILTER, due: 'today' })).toBe(true);
  });

  it('sorts by priority, most urgent first, and by due date, empty ones last', () => {
    const byPriority = { key: 'priority' as const, descending: false };
    expect(titles(sortItems(all, byPriority, fields))).toEqual([
      'Atrasado',
      'Domingo',
      'Hoje',
      'Sem prazo',
      'Feito atrasado',
      'Depois',
    ]);
    const byDue = { key: 'due' as const, descending: false };
    expect(titles(sortItems(all, byDue, fields))).toEqual([
      'Feito atrasado',
      'Atrasado',
      'Hoje',
      'Domingo',
      'Depois',
      'Sem prazo',
    ]);
    expect(titles(sortItems(all, { ...byDue, descending: true }, fields)).at(-1)).toBe('Sem prazo');
  });

  it('groups by priority, most urgent first, with none last', () => {
    expect(
      groupItems(all, 'priority', { fields, nameOf: (id) => id }).map((group) => [
        group.label,
        group.items.map((one) => one.title),
      ]),
    ).toEqual([
      ['1 · Urgente', ['Atrasado']],
      ['2 · Alta', ['Domingo']],
      ['3 · Normal', ['Hoje']],
      ['4 · Baixa', ['Sem prazo']],
      ['Sem prioridade', ['Feito atrasado', 'Depois']],
    ]);
  });
});

describe('a table without a choice of columns', () => {
  it('shows stage, who and the first fields, leaving long texts out', () => {
    const many: FieldLike[] = [
      { id: 'notas', name: 'Notas', kind: 'long_text', config: {} },
      ...fields,
      { id: 'extra', name: 'Extra', kind: 'text', config: {} },
    ];
    expect(defaultColumns(many)).toEqual([
      'etapa',
      'responsaveis',
      'fornecedor',
      'valor',
      'entrega',
      'obs',
      'senha',
      'pronto',
    ]);
  });
});

describe('grouping the list', () => {
  const nameOf = (id: string): string => (id === ME ? 'Olívia' : id === ANA ? 'Ana' : 'Bruno');
  const shape = (groups: ReturnType<typeof groupItems>) =>
    groups.map((group) => [group.label, group.items.map((one) => one.title)]);

  it('by who, under each person, by name, with nobody’s last', () => {
    const both = item({ title: 'De duas', assignees: [ME, ANA] });
    expect(shape(groupItems([...all, both], 'who', { fields, nameOf }))).toEqual([
      ['Ana', ['Subir campanha de Ação', 'De duas']],
      ['Olívia', ['Conferir perfis', 'De duas']],
      ['Sem responsável', ['Ligar para o cliente']],
    ]);
  });

  it('by a choice, in the order the list gave its options, with colors', () => {
    const groups = groupItems(all, 'field:fornecedor', { fields, nameOf });
    expect(shape(groups)).toEqual([
      ['Beta', ['Conferir perfis']],
      ['Alfa', ['Subir campanha de Ação']],
      ['Sem Fornecedor', ['Ligar para o cliente']],
    ]);
    expect(groups[0]?.color).toBe('#dba63f');
  });

  it('by a box, and by any value as it is read', () => {
    expect(shape(groupItems(all, 'field:pronto', { fields, nameOf }))).toEqual([
      ['Sim', ['Conferir perfis']],
      ['Pronto: não', ['Subir campanha de Ação', 'Ligar para o cliente']],
    ]);
    const byValue = shape(groupItems(all, 'field:valor', { fields, nameOf }));
    expect(byValue.at(-1)).toEqual(['Sem Valor', ['Ligar para o cliente']]);
    expect(byValue).toHaveLength(3);
  });

  it('not at all, or as a whole when the field is gone', () => {
    expect(shape(groupItems(all, 'none', { fields, nameOf }))).toEqual([
      ['Todos os itens', all.map((one) => one.title)],
    ]);
    expect(groupItems(all, 'field:sumiu', { fields, nameOf })).toHaveLength(1);
  });

  it('goes in the address and comes back', () => {
    expect(fromSearch(toSearch(NO_FILTER, DEFAULT_SORT, null, 'who')).group).toBe('who');
    expect(fromSearch('?agrupar=<x>').group).toBe('stage');
    expect(toSearch(NO_FILTER, DEFAULT_SORT, null, 'stage')).toBe('');
  });
});

describe('subtasks in the list', () => {
  it('sit under their parent when it is shown, and stand alone when it is not', () => {
    const parent = item({ title: 'Pai' });
    const first = item({ title: 'Primeira', parentId: parent.id });
    const second = item({ title: 'Segunda', parentId: parent.id });
    const orphan = item({ title: 'Órfã', parentId: 'nao-visto' });
    const lone = item({ title: 'Solta' });
    const { top, family } = nestSubtasks([second, parent, lone, first, orphan]);
    expect(top.map((one) => one.title)).toEqual(['Pai', 'Solta', 'Órfã']);
    expect(family.get(parent.id)?.map((one) => one.title)).toEqual(['Segunda', 'Primeira']);
    // Filtered out, the parent no longer holds them.
    expect(nestSubtasks([first, lone]).top.map((one) => one.title)).toEqual(['Primeira', 'Solta']);
  });
});
