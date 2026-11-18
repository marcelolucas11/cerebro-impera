import type { Item } from './api.js';
import { dayOfValue } from './calendar.js';
import type { FieldLike } from './fieldvalues.js';

/*
 * The timeline's arithmetic: a window of whole weeks, and where each item's
 * bar starts and how many days it spans inside it. Days are "YYYY-MM-DD" in
 * the person's own time zone, like the calendar.
 */

const DAY = 24 * 60 * 60 * 1000;
const pad = (n: number): string => String(n).padStart(2, '0');
const toDate = (day: string): Date => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
};
const toDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Days between two days, by the calendar (daylight saving does not count). */
export function daysBetween(from: string, to: string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / DAY);
}

export function addDays(day: string, count: number): string {
  const date = toDate(day);
  date.setDate(date.getDate() + count);
  return toDay(date);
}

/** The Monday on or before a day: the timeline counts weeks from Monday, as work weeks go. */
export function weekStart(day: string): string {
  const date = toDate(day);
  return addDays(day, -((date.getDay() + 6) % 7));
}

/** Every day of a window, first to last. */
export function windowDays(first: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => addDays(first, index));
}

export interface Span {
  start: string;
  end: string;
}

/**
 * When an item happens: from its start to its end field. With only one of
 * them, a single day. An end before the start is read the other way round.
 */
export function spanOf(item: Item, start: FieldLike, end: FieldLike): Span | null {
  const from = dayOfValue(start, item.fields[start.id]);
  const to = dayOfValue(end, item.fields[end.id]);
  if (from === null && to === null) return null;
  const a = from ?? to ?? '';
  const b = to ?? from ?? '';
  return a <= b ? { start: a, end: b } : { start: b, end: a };
}

/** Where a bar sits in the window (0-based column) and how many days it covers; null when outside. */
export function barIn(
  span: Span,
  first: string,
  count: number,
): { column: number; days: number; clippedStart: boolean; clippedEnd: boolean } | null {
  const last = addDays(first, count - 1);
  if (span.end < first || span.start > last) return null;
  const start = span.start < first ? first : span.start;
  const end = span.end > last ? last : span.end;
  return {
    column: daysBetween(first, start),
    days: daysBetween(start, end) + 1,
    clippedStart: span.start < first,
    clippedEnd: span.end > last,
  };
}
