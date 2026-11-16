/*
 * Custom fields: what a list records about each of its items beyond the title.
 * The same rules are written twice on purpose: here, so the page and the API
 * can explain a mistake, and in the database, so they hold on every path.
 */

export const FIELD_KINDS = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'datetime',
  'select',
  'labels',
  'checkbox',
  'url',
  'email',
  'phone',
  'rating',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

export interface FieldOption {
  id: string;
  name: string;
  color: string;
  /** An archived option stays on the items that have it and cannot be chosen again. */
  archived?: boolean | undefined;
}

export interface FieldConfig {
  options?: FieldOption[] | undefined;
  /** ISO 4217 code a money field is shown in. */
  currency?: string | undefined;
  /** Highest value of a rating field. */
  max?: number | undefined;
}

/**
 * How each kind is stored: text kinds as a string; `number` as a number;
 * `money` as a whole number of cents; `date` as YYYY-MM-DD; `datetime` as a UTC
 * instant; `select` as an option id; `labels` as a list of option ids;
 * `checkbox` as true or false; `rating` as a whole number from 1 to the maximum.
 */
export type FieldValue = string | number | boolean | string[];

export const MAX_FIELDS_PER_LIST = 60;
export const MAX_FIELD_OPTIONS = 100;
export const MAX_LABELS_PER_VALUE = 50;
export const DEFAULT_OPTION_COLOR = '#9ba6b8';

const TEXT_LIMITS: Partial<Record<FieldKind, number>> = {
  text: 500,
  long_text: 20_000,
  url: 2000,
  email: 320,
  phone: 40,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLOR = /^#[0-9a-f]{6}$/;
const URL_PATTERN = /^https?:\/\/[^\s]+$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_PATTERN = /^[0-9+() .-]{3,40}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const MAX_NUMBER = 1e15;

export const usesOptions = (kind: FieldKind): boolean => kind === 'select' || kind === 'labels';

/** The configuration a field of this kind starts with. */
export function defaultFieldConfig(kind: FieldKind): FieldConfig {
  if (usesOptions(kind)) return { options: [] };
  if (kind === 'money') return { currency: 'BRL' };
  if (kind === 'rating') return { max: 5 };
  return {};
}

export type FieldConfigProblem =
  | 'unexpected_setting'
  | 'invalid_options'
  | 'too_many_options'
  | 'duplicate_option'
  | 'invalid_currency'
  | 'invalid_max';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(config: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(config).every((key) => allowed.includes(key));
}

/** What is wrong with a field's configuration, or null when it is fine. */
export function fieldConfigProblem(kind: FieldKind, config: unknown): FieldConfigProblem | null {
  if (!isRecord(config)) return 'unexpected_setting';
  if (usesOptions(kind)) {
    if (!onlyKeys(config, ['options'])) return 'unexpected_setting';
    const options = config['options'];
    if (!Array.isArray(options)) return 'invalid_options';
    if (options.length > MAX_FIELD_OPTIONS) return 'too_many_options';
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const option of options) {
      if (!isRecord(option) || !onlyKeys(option, ['id', 'name', 'color', 'archived'])) {
        return 'invalid_options';
      }
      const { id, name, color, archived } = option;
      if (typeof id !== 'string' || !UUID.test(id)) return 'invalid_options';
      if (typeof name !== 'string' || name.trim() !== name) return 'invalid_options';
      if (name.length < 1 || name.length > 60) return 'invalid_options';
      if (typeof color !== 'string' || !COLOR.test(color)) return 'invalid_options';
      if (archived !== undefined && typeof archived !== 'boolean') return 'invalid_options';
      if (ids.has(id)) return 'duplicate_option';
      ids.add(id);
      if (archived !== true) {
        const key = name.toLowerCase();
        if (names.has(key)) return 'duplicate_option';
        names.add(key);
      }
    }
    return null;
  }
  if (kind === 'money') {
    if (!onlyKeys(config, ['currency'])) return 'unexpected_setting';
    const currency = config['currency'];
    return typeof currency === 'string' && /^[A-Z]{3}$/.test(currency) ? null : 'invalid_currency';
  }
  if (kind === 'rating') {
    if (!onlyKeys(config, ['max'])) return 'unexpected_setting';
    const max = config['max'];
    return typeof max === 'number' && Number.isInteger(max) && max >= 3 && max <= 10
      ? null
      : 'invalid_max';
  }
  return Object.keys(config).length === 0 ? null : 'unexpected_setting';
}

export type FieldValueProblem =
  | 'wrong_type'
  | 'empty'
  | 'too_long'
  | 'invalid_url'
  | 'invalid_email'
  | 'invalid_phone'
  | 'invalid_date'
  | 'out_of_range'
  | 'not_whole'
  | 'unknown_option'
  | 'too_many_labels'
  | 'duplicate_label';

function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1900 || year > 2200) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function selectableIds(config: FieldConfig, previous: unknown): Set<string> {
  const kept = new Set<string>(
    typeof previous === 'string'
      ? [previous]
      : Array.isArray(previous)
        ? previous.filter((id): id is string => typeof id === 'string')
        : [],
  );
  const allowed = new Set<string>();
  for (const option of config.options ?? []) {
    // An archived option can stay where it already is; it cannot be newly chosen.
    if (option.archived !== true || kept.has(option.id)) allowed.add(option.id);
  }
  return allowed;
}

/**
 * What is wrong with a value for a field, or null when it can be saved.
 * `previous` is the value the item has now: options archived since then may stay.
 */
export function fieldValueProblem(
  kind: FieldKind,
  config: FieldConfig,
  value: unknown,
  previous?: unknown,
): FieldValueProblem | null {
  switch (kind) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'email':
    case 'phone': {
      if (typeof value !== 'string') return 'wrong_type';
      if (value.trim() === '') return 'empty';
      if (value.length > (TEXT_LIMITS[kind] ?? 500)) return 'too_long';
      if (kind === 'url' && !URL_PATTERN.test(value)) return 'invalid_url';
      if (kind === 'email' && !EMAIL_PATTERN.test(value)) return 'invalid_email';
      if (kind === 'phone' && !PHONE_PATTERN.test(value)) return 'invalid_phone';
      return null;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'wrong_type';
      return Math.abs(value) <= MAX_NUMBER ? null : 'out_of_range';
    }
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'wrong_type';
      if (!Number.isInteger(value)) return 'not_whole';
      return Math.abs(value) <= MAX_NUMBER ? null : 'out_of_range';
    }
    case 'rating': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'wrong_type';
      if (!Number.isInteger(value)) return 'not_whole';
      return value >= 1 && value <= (config.max ?? 5) ? null : 'out_of_range';
    }
    case 'checkbox':
      return typeof value === 'boolean' ? null : 'wrong_type';
    case 'date':
      if (typeof value !== 'string') return 'wrong_type';
      return isRealDate(value) ? null : 'invalid_date';
    case 'datetime': {
      if (typeof value !== 'string') return 'wrong_type';
      if (!DATETIME_PATTERN.test(value) || !isRealDate(value.slice(0, 10))) return 'invalid_date';
      return Number.isNaN(Date.parse(value)) ? 'invalid_date' : null;
    }
    case 'select': {
      if (typeof value !== 'string') return 'wrong_type';
      return selectableIds(config, previous).has(value) ? null : 'unknown_option';
    }
    case 'labels': {
      if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
        return 'wrong_type';
      }
      if (value.length === 0) return 'empty';
      if (value.length > MAX_LABELS_PER_VALUE) return 'too_many_labels';
      if (new Set(value).size !== value.length) return 'duplicate_label';
      const allowed = selectableIds(config, previous);
      return value.every((id) => typeof id === 'string' && allowed.has(id))
        ? null
        : 'unknown_option';
    }
  }
}
