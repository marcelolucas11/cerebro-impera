import type { Item, Recurrence } from './api.js';
import { addDays } from './timeline.js';

/*
 * Priority and due dates as people read them. Days are compared as text
 * (YYYY-MM-DD), against today where the person is: "due on the 20th" is the
 * 20th for everyone.
 */

export const PRIORITY_NAMES: Record<number, string> = {
  1: 'Urgente',
  2: 'Alta',
  3: 'Normal',
  4: 'Baixa',
};

/** "1 · Urgente", or null when the item has no priority. */
export function priorityLabel(priority: number | null): string | null {
  if (priority === null) return null;
  const name = PRIORITY_NAMES[priority];
  return name === undefined ? null : `${String(priority)} · ${name}`;
}

/**
 * Where a due date stands: past and still open, today, within the next six
 * days, later, or no longer pressing because the item is finished.
 */
export type DueState = 'overdue' | 'today' | 'soon' | 'later' | 'finished';

export function dueState(
  dueDate: string | null,
  today: string,
  finished: boolean,
): DueState | null {
  if (dueDate === null) return null;
  if (finished) return 'finished';
  if (dueDate < today) return 'overdue';
  if (dueDate === today) return 'today';
  return dueDate <= addDays(today, 6) ? 'soon' : 'later';
}

/** "20/11", with the year only when it is not this one. */
export function formatDay(day: string, today: string): string {
  const [year, month, date] = day.split('-');
  return year === today.slice(0, 4)
    ? `${date ?? ''}/${month ?? ''}`
    : `${date ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** "20/11/2026": a day with its year, for records that outlive the year. */
export function fullDay(day: string): string {
  const [year, month, date] = day.split('-');
  return `${date ?? ''}/${month ?? ''}/${year ?? ''}`;
}

/** How the due date reads next to an item. */
export function dueText(dueDate: string, today: string, state: DueState): string {
  if (state === 'today') return 'Vence hoje';
  if (dueDate === addDays(today, 1) && state === 'soon') return 'Vence amanhã';
  const day = formatDay(dueDate, today);
  return state === 'overdue' ? `Atrasado desde ${day}` : `Prazo ${day}`;
}

/** Whether an item is in a stage that means it is done or closed. */
export function isFinished(item: Item, finishedStages: ReadonlySet<string>): boolean {
  return finishedStages.has(item.stageId);
}

const UNIT_WORDS: Record<Recurrence['unit'], { one: string; many: string; gender: 'm' | 'f' }> = {
  day: { one: 'dia', many: 'dias', gender: 'm' },
  week: { one: 'semana', many: 'semanas', gender: 'f' },
  month: { one: 'mês', many: 'meses', gender: 'm' },
  year: { one: 'ano', many: 'anos', gender: 'm' },
};

/** "toda semana", "a cada 2 meses": how often an item comes back. */
export function recurrenceText(rule: Recurrence): string {
  const words = UNIT_WORDS[rule.unit];
  if (rule.every === 1) return `${words.gender === 'f' ? 'toda' : 'todo'} ${words.one}`;
  return `a cada ${String(rule.every)} ${words.many}`;
}

/** The choices offered for repeating, most common first. */
export const RECURRENCE_CHOICES: readonly Recurrence[] = [
  { unit: 'day', every: 1 },
  { unit: 'week', every: 1 },
  { unit: 'week', every: 2 },
  { unit: 'month', every: 1 },
  { unit: 'month', every: 3 },
  { unit: 'year', every: 1 },
];
