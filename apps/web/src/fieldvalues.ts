import {
  fieldValueProblem,
  type FieldConfig,
  type FieldKind,
  type FieldValue,
  type FieldValueProblem,
} from '@cerebro/shared';

/*
 * Custom field values between the three shapes they take: what is stored, what
 * is being typed, and what is read. All of it pure, so it can be tested without
 * a screen.
 */

export interface FieldLike {
  id: string;
  name: string;
  kind: FieldKind;
  config: FieldConfig;
}

export const FIELD_KIND_NAMES: Record<FieldKind, string> = {
  text: 'Texto',
  long_text: 'Texto longo',
  number: 'Número',
  money: 'Dinheiro',
  date: 'Data',
  datetime: 'Data e hora',
  select: 'Escolha única',
  labels: 'Marcadores',
  checkbox: 'Sim ou não',
  url: 'Link',
  email: 'E-mail',
  phone: 'Telefone',
  rating: 'Nota',
  people: 'Pessoas',
};

export const FIELD_KIND_HINTS: Record<FieldKind, string> = {
  text: 'Uma linha: um nome, um código.',
  long_text: 'Várias linhas: observações, instruções.',
  number: 'Uma quantidade, com ou sem casas decimais.',
  money: 'Um valor em dinheiro, na moeda escolhida.',
  date: 'Um dia.',
  datetime: 'Um dia e uma hora.',
  select: 'Uma opção de uma lista que você define.',
  labels: 'Várias opções de uma lista que você define.',
  checkbox: 'Uma caixa para marcar.',
  url: 'Um endereço de site, que abre em outra aba.',
  email: 'Um endereço de e-mail.',
  phone: 'Um número de telefone.',
  rating: 'Uma nota de 1 até o máximo que você escolher.',
  people: 'Uma ou mais pessoas que trabalham nesta lista.',
};

export const CURRENCIES: readonly { value: string; label: string }[] = [
  { value: 'BRL', label: 'Real (R$)' },
  { value: 'USD', label: 'Dólar americano (US$)' },
  { value: 'EUR', label: 'Euro (€)' },
  { value: 'GBP', label: 'Libra esterlina (£)' },
  { value: 'ARS', label: 'Peso argentino' },
  { value: 'PYG', label: 'Guarani' },
  { value: 'UYU', label: 'Peso uruguaio' },
];

const FIELD_PROBLEMS: Record<FieldValueProblem, string> = {
  wrong_type: 'Esse valor não serve para este campo.',
  empty: 'Deixe em branco para limpar, ou escreva algo.',
  too_long: 'Texto longo demais para este campo.',
  invalid_url: 'Escreva o endereço completo, começando por https://',
  invalid_email: 'Confira o e-mail: falta algo como nome@empresa.com',
  invalid_phone: 'Use só números, espaços e os sinais + ( ) -',
  invalid_date: 'Essa data não existe. Confira o dia e o mês.',
  out_of_range: 'Número fora do limite deste campo.',
  not_whole: 'Use um número inteiro.',
  unknown_option: 'Essa opção não está mais disponível. Escolha outra.',
  too_many_labels: 'Marcadores demais em um item só.',
  duplicate_label: 'O mesmo marcador foi escolhido duas vezes.',
  too_many_people: 'Pessoas demais em um campo só (até 20).',
  duplicate_person: 'A mesma pessoa foi escolhida duas vezes.',
};

export const describeFieldProblem = (problem: unknown): string =>
  typeof problem === 'string' && problem in FIELD_PROBLEMS
    ? FIELD_PROBLEMS[problem as FieldValueProblem]
    : 'Esse valor não serve para este campo.';

/** Colors new options take in turn, so two options never start out looking alike. */
export const OPTION_COLORS: readonly string[] = [
  '#58b98a',
  '#dba63f',
  '#8fb8ff',
  '#ef7b6a',
  '#c59bf0',
  '#5cc8d6',
  '#e79ac0',
  '#9ba6b8',
];

/** Whether a field shows anything for this value. An unticked box counts as nothing. */
export function hasValue(field: FieldLike, value: FieldValue | undefined): boolean {
  if (field.kind === 'checkbox') return value === true;
  if (field.kind === 'select' || field.kind === 'labels') return optionsOf(field, value).length > 0;
  if (field.kind === 'people') return Array.isArray(value) && value.length > 0;
  return showValue(field, value) !== '';
}

/** What is in an input while the person edits: text, a set of options, or a tick. */
export type FieldDraft = string | string[] | boolean;

const pad = (value: number): string => String(value).padStart(2, '0');

/** A stored instant as the local date and time an `<input type="datetime-local">` shows. */
function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const plainNumber = new Intl.NumberFormat('pt-BR', {
  useGrouping: false,
  maximumFractionDigits: 6,
});
const plainMoney = new Intl.NumberFormat('pt-BR', {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** What the input starts with, for a stored value or none. */
export function draftOf(field: FieldLike, value: FieldValue | undefined): FieldDraft {
  switch (field.kind) {
    case 'checkbox':
      return value === true;
    case 'labels':
    case 'people':
      return Array.isArray(value) ? [...value] : [];
    case 'number':
      return typeof value === 'number' ? plainNumber.format(value) : '';
    case 'money':
      return typeof value === 'number' ? plainMoney.format(value / 100) : '';
    case 'rating':
      return typeof value === 'number' ? String(value) : '';
    case 'datetime':
      return typeof value === 'string' ? localDateTime(value) : '';
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * A number as people here type it: comma for decimals, dot for thousands
 * ("1.499,90"). A lone dot followed by exactly three digits is read as
 * thousands ("1.500"); any other lone dot as a decimal point ("12.5").
 */
export function parseDecimal(raw: string): number | null {
  const text = raw.trim().replace(/\s/g, '');
  if (!/^-?[0-9.,]+$/.test(text) || !/[0-9]/.test(text)) return null;
  let normalized: string;
  if (text.includes(',')) {
    if ((text.match(/,/g) ?? []).length > 1) return null;
    normalized = text.replace(/\./g, '').replace(',', '.');
  } else {
    const dots = (text.match(/\./g) ?? []).length;
    const thousands = /^-?[0-9]{1,3}(\.[0-9]{3})+$/.test(text);
    if (dots > 1 && !thousands) return null;
    normalized = thousands ? text.replace(/\./g, '') : text;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

export type Parsed = { ok: true; value: FieldValue | null } | { ok: false; message: string };

/**
 * What to store for what was typed: a value, `null` to clear the field, or a
 * sentence saying what to fix. `previous` is what the item has now.
 */
export function valueOf(
  field: FieldLike,
  draft: FieldDraft,
  previous: FieldValue | undefined,
): Parsed {
  let value: FieldValue | null;
  switch (field.kind) {
    case 'checkbox':
      // Unticked and never answered read the same, so only a tick is stored.
      value = draft === true ? true : null;
      break;
    case 'labels':
    case 'people':
      value = Array.isArray(draft) && draft.length > 0 ? draft : null;
      break;
    case 'number':
    case 'money':
    case 'rating': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') {
        value = null;
        break;
      }
      const parsed = parseDecimal(text);
      if (parsed === null) return { ok: false, message: 'Escreva um número, como 1.250,50' };
      if (field.kind === 'money') {
        const cents = Math.round(parsed * 100);
        if (Math.abs(parsed * 100 - cents) > 1e-6) {
          return { ok: false, message: 'Use no máximo dois dígitos depois da vírgula.' };
        }
        value = cents;
      } else {
        value = parsed;
      }
      break;
    }
    case 'datetime': {
      const text = typeof draft === 'string' ? draft.trim() : '';
      if (text === '') {
        value = null;
        break;
      }
      const date = new Date(text);
      if (Number.isNaN(date.getTime())) {
        return { ok: false, message: describeFieldProblem('invalid_date') };
      }
      value = date.toISOString();
      break;
    }
    default: {
      const text = typeof draft === 'string' ? draft.trim() : '';
      value = text === '' ? null : text;
    }
  }
  if (value === null) return { ok: true, value };
  const problem = fieldValueProblem(field.kind, field.config, value, previous);
  return problem === null
    ? { ok: true, value }
    : { ok: false, message: describeFieldProblem(problem) };
}

/** Whether two stored values are the same; marker lists compare regardless of order. */
export function sameValue(
  a: FieldValue | null | undefined,
  b: FieldValue | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((id) => right.includes(id));
  }
  return left === right;
}

const day = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeZone: 'UTC' });
const instant = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const quantity = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 });

function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${quantity.format(cents / 100)} ${currency}`;
  }
}

/** The names of the options a choice value points at; options that no longer exist are skipped. */
export function optionsOf(
  field: FieldLike,
  value: FieldValue | undefined,
): { id: string; name: string; color: string; archived: boolean }[] {
  const ids = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const known = new Map((field.config.options ?? []).map((option) => [option.id, option]));
  return ids.flatMap((id) => {
    const option = known.get(id);
    return option
      ? [{ id, name: option.name, color: option.color, archived: option.archived === true }]
      : [];
  });
}

/**
 * A stored value as a person reads it. Empty when there is nothing to show.
 * `nameOf` names the people of a people field; without it they are counted.
 */
export function showValue(
  field: FieldLike,
  value: FieldValue | undefined,
  nameOf?: (userId: string) => string,
): string {
  if (value === undefined) return field.kind === 'checkbox' ? 'Não' : '';
  switch (field.kind) {
    case 'checkbox':
      return value === true ? 'Sim' : 'Não';
    case 'number':
      return typeof value === 'number' ? quantity.format(value) : '';
    case 'money':
      return typeof value === 'number' ? money(value, field.config.currency ?? 'BRL') : '';
    case 'rating':
      return typeof value === 'number' ? `${value} de ${field.config.max ?? 5}` : '';
    case 'date': {
      if (typeof value !== 'string') return '';
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(date.getTime()) ? '' : day.format(date);
    }
    case 'datetime': {
      if (typeof value !== 'string') return '';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : instant.format(date);
    }
    case 'people': {
      if (!Array.isArray(value)) return '';
      if (nameOf) return value.map(nameOf).join(', ');
      return value.length === 1 ? '1 pessoa' : `${value.length} pessoas`;
    }
    case 'select':
    case 'labels':
      return optionsOf(field, value)
        .map((option) => option.name)
        .join(', ');
    default:
      return typeof value === 'string' ? value : '';
  }
}

/**
 * Where a link value may safely point. Only web addresses, e-mail and phone:
 * never a `javascript:` or `data:` address, whatever was stored.
 */
export function linkOf(field: FieldLike, value: FieldValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (field.kind === 'url') return /^https?:\/\/[^\s]+$/i.test(value) ? value : null;
  if (field.kind === 'email') {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) ? `mailto:${value}` : null;
  }
  if (field.kind === 'phone') {
    const digits = value.replace(/[^0-9+]/g, '');
    return /^\+?[0-9]{3,20}$/.test(digits) ? `tel:${digits}` : null;
  }
  return null;
}
