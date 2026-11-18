import type { FieldValue } from '@cerebro/shared';
import type { Item } from './api.js';
import type { FieldLike } from './fieldvalues.js';

/*
 * The calendar's arithmetic: which days a month shows, and on which day each
 * item falls. Days are plain "YYYY-MM-DD" strings in the person's own time
 * zone, so nothing moves a day because of UTC.
 */

export interface CalendarDay {
  /** "2026-11-18". */
  date: string;
  inMonth: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');
export const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** "2026-11" for the month a date is in. */
export const monthOf = (day: string): string => day.slice(0, 7);

/** The month before or after, as "YYYY-MM". */
export function shiftMonth(month: string, by: number): string {
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year ?? 1970, (number ?? 1) - 1 + by, 1);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/**
 * Whole weeks, Sunday first as calendars here are printed, covering the
 * month: from the Sunday on or before the 1st to the Saturday on or after
 * the last day.
 */
export function monthGrid(month: string): CalendarDay[] {
  const [year, number] = month.split('-').map(Number);
  const first = new Date(year ?? 1970, (number ?? 1) - 1, 1);
  const last = new Date(year ?? 1970, number ?? 1, 0);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const end = new Date(last);
  end.setDate(last.getDate() + (6 - last.getDay()));
  const days: CalendarDay[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
    days.push({ date: isoDay(cursor), inMonth: cursor.getMonth() === first.getMonth() });
  }
  return days;
}

/** The day a stored value falls on, here: a date as is, an instant in local time. */
export function dayOfValue(field: FieldLike, value: FieldValue | undefined): string | null {
  if (typeof value !== 'string') return null;
  if (field.kind === 'date') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
  if (field.kind === 'datetime') {
    const instant = new Date(value);
    return Number.isNaN(instant.getTime()) ? null : isoDay(instant);
  }
  return null;
}

/** Items by the day they fall on, keeping their order; and those with no day at all. */
export function itemsByDay(
  items: readonly Item[],
  field: FieldLike,
): { byDay: Map<string, Item[]>; undated: Item[] } {
  const byDay = new Map<string, Item[]>();
  const undated: Item[] = [];
  for (const item of items) {
    const day = dayOfValue(field, item.fields[field.id]);
    if (day === null) {
      undated.push(item);
      continue;
    }
    const list = byDay.get(day) ?? [];
    list.push(item);
    byDay.set(day, list);
  }
  return { byDay, undated };
}

export const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const MONTH_NAME = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

/** "novembro de 2026". */
export function monthName(month: string): string {
  const [year, number] = month.split('-').map(Number);
  return MONTH_NAME.format(new Date(year ?? 1970, (number ?? 1) - 1, 1));
}
