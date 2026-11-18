import type { FieldKind, FieldValue } from '@cerebro/shared';
import type { Item } from './api.js';
import type { FieldLike } from './fieldvalues.js';

/*
 * Narrowing and ordering what a list shows. Everything here works on items
 * the person already received: a filter never reveals anything, it only
 * hides. The state is plain text so it fits in the address (and, later, in a
 * saved view).
 */

/** "anyone", "me", "nobody", or the id of a person. */
export type Who = string;

/** What can be asked of one field, by kind. */
export type FieldTest =
  | { op: 'filled' }
  | { op: 'empty' }
  | { op: 'is'; value: string }
  | { op: 'contains'; value: string }
  | { op: 'atLeast'; value: number }
  | { op: 'atMost'; value: number }
  | { op: 'from'; value: string }
  | { op: 'until'; value: string };

export interface Filter {
  /** Words that must all appear in the title, ignoring case and accents. */
  text: string;
  who: Who;
  stageId: string | null;
  field: { id: string; test: FieldTest } | null;
}

export type SortKey = 'manual' | 'stage' | 'title' | 'created' | 'updated' | `field:${string}`;
export interface Sort {
  key: SortKey;
  descending: boolean;
}

export const NO_FILTER: Filter = { text: '', who: 'anyone', stageId: null, field: null };
/** The board's own order: where people placed the cards, then whoever waited longest. */
export const DEFAULT_SORT: Sort = { key: 'manual', descending: false };

export function isFiltering(filter: Filter): boolean {
  return (
    filter.text.trim() !== '' ||
    filter.who !== 'anyone' ||
    filter.stageId !== null ||
    filter.field !== null
  );
}

/** Lowercase, without accents: "Ação" and "acao" are the same search. */
export function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** The tests that make sense for a kind of field, in the order they are offered. */
export function testsFor(kind: FieldKind): FieldTest['op'][] {
  switch (kind) {
    case 'select':
    case 'labels':
    case 'people':
      return ['is', 'filled', 'empty'];
    case 'checkbox':
      return ['filled', 'empty'];
    case 'number':
    case 'money':
    case 'rating':
      return ['atLeast', 'atMost', 'filled', 'empty'];
    case 'date':
    case 'datetime':
      return ['from', 'until', 'filled', 'empty'];
    case 'secret':
    case 'files':
      return ['filled', 'empty'];
    default:
      return ['contains', 'filled', 'empty'];
  }
}

interface Context {
  me: string;
  fields: readonly FieldLike[];
}

function hasAny(item: Item, field: FieldLike): boolean {
  if (field.kind === 'secret') return item.secrets.includes(field.id);
  const value = item.fields[field.id];
  if (value === undefined) return false;
  if (field.kind === 'checkbox') return value === true;
  return Array.isArray(value) ? value.length > 0 : value !== '';
}

/** A comparable day for a date or an instant: "2026-11-18". */
const dayOf = (value: FieldValue | undefined): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

function passes(item: Item, field: FieldLike, test: FieldTest): boolean {
  const value = item.fields[field.id];
  switch (test.op) {
    case 'filled':
      return hasAny(item, field);
    case 'empty':
      return !hasAny(item, field);
    case 'is':
      return Array.isArray(value) ? value.includes(test.value) : value === test.value;
    case 'contains':
      return typeof value === 'string' && plain(value).includes(plain(test.value.trim()));
    case 'atLeast':
    case 'atMost': {
      if (typeof value !== 'number') return false;
      // Money is stored in cents and typed in units.
      const limit = field.kind === 'money' ? Math.round(test.value * 100) : test.value;
      return test.op === 'atLeast' ? value >= limit : value <= limit;
    }
    case 'from':
    case 'until': {
      const day = dayOf(value);
      if (day === null) return false;
      return test.op === 'from' ? day >= test.value : day <= test.value;
    }
  }
}

export function matches(item: Item, filter: Filter, context: Context): boolean {
  const words = plain(filter.text).split(/\s+/).filter(Boolean);
  const title = plain(item.title);
  if (!words.every((word) => title.includes(word))) return false;
  if (filter.who === 'me' && !item.assignees.includes(context.me)) return false;
  if (filter.who === 'nobody' && item.assignees.length > 0) return false;
  if (
    filter.who !== 'anyone' &&
    filter.who !== 'me' &&
    filter.who !== 'nobody' &&
    !item.assignees.includes(filter.who)
  ) {
    return false;
  }
  if (filter.stageId !== null && item.stageId !== filter.stageId) return false;
  if (filter.field !== null) {
    const field = context.fields.find((candidate) => candidate.id === filter.field?.id);
    // A field that is gone (archived, or not this list's) filters nothing out.
    if (field && !passes(item, field, filter.field.test)) return false;
  }
  return true;
}

/** What an item is sorted by; null sorts last, whichever the direction. */
function sortValue(item: Item, key: SortKey, fields: readonly FieldLike[]): string | number | null {
  switch (key) {
    case 'manual':
    case 'stage':
      return Date.parse(item.stageSince);
    case 'title':
      return plain(item.title);
    case 'created':
      return Date.parse(item.createdAt);
    case 'updated':
      return Date.parse(item.updatedAt);
    default: {
      const field = fields.find((candidate) => `field:${candidate.id}` === key);
      if (!field) return null;
      const value = item.fields[field.id];
      if (value === undefined) return null;
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (field.kind === 'select') {
        // Options sort in the order the list gave them, not alphabetically.
        const index = (field.config.options ?? []).findIndex((option) => option.id === value);
        return index === -1 ? null : index;
      }
      if (Array.isArray(value)) return value.length;
      return field.kind === 'date' || field.kind === 'datetime' ? value : plain(value);
    }
  }
}

export function sortItems(
  items: readonly Item[],
  sort: Sort,
  fields: readonly FieldLike[],
): Item[] {
  const direction = sort.descending ? -1 : 1;
  if (sort.key === 'manual') {
    // Placed cards first, in their places; the rest after, longest waiting first.
    return [...items].sort((a, b) => {
      const placed =
        a.position !== null && b.position !== null
          ? a.position - b.position
          : a.position !== null
            ? -1
            : b.position !== null
              ? 1
              : Date.parse(a.stageSince) - Date.parse(b.stageSince);
      return (placed === 0 ? a.id.localeCompare(b.id) : placed) * direction;
    });
  }
  return [...items].sort((a, b) => {
    const left = sortValue(a, sort.key, fields);
    const right = sortValue(b, sort.key, fields);
    if (left === null || right === null) {
      if (left === right) return a.id.localeCompare(b.id);
      return left === null ? 1 : -1;
    }
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right), 'pt-BR');
    return order === 0 ? a.id.localeCompare(b.id) : order * direction;
  });
}

// ---- In the address ---------------------------------------------------------

const OPS = new Set<FieldTest['op']>([
  'filled',
  'empty',
  'is',
  'contains',
  'atLeast',
  'atMost',
  'from',
  'until',
]);

/**
 * The columns a table shows, by id: a field's id, or one of the fixed ones.
 * Null means the table's default choice.
 */
export type Columns = string[] | null;
export const FIXED_COLUMNS = ['etapa', 'responsaveis', 'criado', 'atualizado'] as const;
const COLUMN_ID = /^[a-z0-9-]{1,40}$/;

/** Without a choice: stage, who, and the first fields of the list (long texts left out). */
export function defaultColumns(fields: readonly FieldLike[]): string[] {
  return [
    'etapa',
    'responsaveis',
    ...fields
      .filter((field) => field.kind !== 'long_text')
      .slice(0, 6)
      .map((field) => field.id),
  ];
}

/** Reads what the address says, ignoring anything that does not make sense. */
export function fromSearch(search: string): { filter: Filter; sort: Sort; columns: Columns } {
  const params = new URLSearchParams(search);
  const text = (params.get('busca') ?? '').slice(0, 200);
  const who = params.get('quem') ?? 'anyone';
  const stageId = params.get('etapa');
  let field: Filter['field'] = null;
  const fieldId = params.get('campo');
  const op = params.get('teste') as FieldTest['op'] | null;
  if (fieldId !== null && op !== null && OPS.has(op)) {
    const raw = params.get('valor') ?? '';
    if (op === 'filled' || op === 'empty') field = { id: fieldId, test: { op } };
    else if (op === 'atLeast' || op === 'atMost') {
      const number = Number(raw);
      if (raw !== '' && Number.isFinite(number))
        field = { id: fieldId, test: { op, value: number } };
    } else if (raw !== '') field = { id: fieldId, test: { op, value: raw.slice(0, 200) } };
  }
  const key = params.get('ordem') ?? 'manual';
  const sortKey: SortKey =
    key === 'stage' ||
    key === 'title' ||
    key === 'created' ||
    key === 'updated' ||
    key.startsWith('field:')
      ? (key as SortKey)
      : 'manual';
  const listed = params.get('colunas');
  const columns =
    listed === null
      ? null
      : [...new Set(listed.split(','))].filter((id) => COLUMN_ID.test(id)).slice(0, 80);
  return {
    filter: { text, who, stageId, field },
    sort: { key: sortKey, descending: params.get('direcao') === 'desc' },
    columns,
  };
}

/** The address part for a filter, an order and a table's columns; empty when nothing is chosen. */
export function toSearch(filter: Filter, sort: Sort, columns: Columns = null): string {
  const params = new URLSearchParams();
  if (filter.text.trim() !== '') params.set('busca', filter.text.trim());
  if (filter.who !== 'anyone') params.set('quem', filter.who);
  if (filter.stageId !== null) params.set('etapa', filter.stageId);
  if (filter.field !== null) {
    params.set('campo', filter.field.id);
    params.set('teste', filter.field.test.op);
    if ('value' in filter.field.test) params.set('valor', String(filter.field.test.value));
  }
  if (sort.key !== 'manual') params.set('ordem', sort.key);
  if (sort.descending) params.set('direcao', 'desc');
  if (columns !== null) params.set('colunas', columns.join(','));
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
