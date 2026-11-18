import type { ReportTotals } from './api.js';
import { addDays } from './timeline.js';

/* The weekly report in words: which week, and how each number moved. */

/** "09/11 a 15/11/2026": Monday to Sunday. */
export function weekLabel(weekStart: string): string {
  const day = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const end = addDays(weekStart, 6);
  return `${day(weekStart)} a ${day(end)}/${end.slice(0, 4)}`;
}

/** How a number compares with the week before, or null when there is no week before. */
export function change(now: number, before: number | null): string | null {
  if (before === null) return null;
  const difference = now - before;
  if (difference === 0) return 'igual à semana anterior';
  const amount = difference > 0 ? `+${String(difference)}` : `−${String(-difference)}`;
  return `${amount} em relação à semana anterior`;
}

export const TOTAL_NAMES: readonly { key: keyof ReportTotals; label: string }[] = [
  { key: 'created', label: 'Entraram' },
  { key: 'finished', label: 'Concluídos' },
  { key: 'open', label: 'Em aberto' },
  { key: 'overdue', label: 'Atrasados' },
];
