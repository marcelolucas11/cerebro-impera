import { describe, expect, it } from 'vitest';
import type { Item } from '../src/api.js';
import {
  dateSources,
  dayOfValue,
  DUE_SOURCE,
  itemsByDay,
  monthGrid,
  monthName,
  shiftMonth,
  type CalendarDay,
} from '../src/calendar.js';
import type { FieldLike } from '../src/fieldvalues.js';

const due: FieldLike = { id: 'entrega', name: 'Entrega', kind: 'date', config: {} };
const when: FieldLike = { id: 'reuniao', name: 'Reunião', kind: 'datetime', config: {} };

const item = (id: string, fields: Item['fields']): Item => ({
  id,
  listId: 'lista',
  title: id,
  description: '',
  createdBy: 'ana',
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  assignees: [],
  stageId: 'a-fazer',
  stageSince: '2026-11-01T00:00:00Z',
  fields,
  secrets: [],
  position: null,
  priority: null,
  startDate: null,
  dueDate: null,
  parentId: null,
  checks: { done: 0, total: 0 },
  comments: 0,
  recurrence: null,
  trashedAt: null,
  trashedBy: null,
});

describe('a month on the calendar', () => {
  const inMonth = (days: CalendarDay[]) => days.filter((day) => day.inMonth);

  it('is whole weeks, Sunday first, covering every day of the month', () => {
    // November 2026 starts on a Sunday and ends on a Monday.
    const november = monthGrid('2026-11');
    expect(november).toHaveLength(35);
    expect(november[0]).toEqual({ date: '2026-11-01', inMonth: true });
    expect(november.at(-1)).toEqual({ date: '2026-12-05', inMonth: false });
    expect(inMonth(november)).toHaveLength(30);
    // February 2027 starts on a Monday: the grid begins in January.
    const february = monthGrid('2027-02');
    expect(february[0]).toEqual({ date: '2027-01-31', inMonth: false });
    expect(inMonth(february)).toHaveLength(28);
    expect(february.length % 7).toBe(0);
  });

  it('moves across years, and is named the way it is said here', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(monthName('2026-11')).toBe('novembro de 2026');
  });
});

describe('the day an item falls on', () => {
  it('is the date itself, or the local day of an instant', () => {
    expect(dayOfValue(due, '2026-11-20')).toBe('2026-11-20');
    expect(dayOfValue(due, 'amanhã')).toBeNull();
    const local = new Date(2026, 10, 20, 23, 30);
    expect(dayOfValue(when, local.toISOString())).toBe('2026-11-20');
    expect(dayOfValue(when, undefined)).toBeNull();
  });

  it('groups items by day, keeping their order, and sets aside those without one', () => {
    const { byDay, undated } = itemsByDay(
      [
        item('b', { entrega: '2026-11-20' }),
        item('a', { entrega: '2026-11-20' }),
        item('sem', {}),
        item('outro', { entrega: '2026-11-21' }),
      ],
      due,
    );
    expect(byDay.get('2026-11-20')?.map((one) => one.id)).toEqual(['b', 'a']);
    expect(byDay.get('2026-11-21')?.map((one) => one.id)).toEqual(['outro']);
    expect(undated.map((one) => one.id)).toEqual(['sem']);
  });

  it('can be the item’s own due date, offered before the list’s date fields', () => {
    const own = { ...item('prazo', { entrega: '2026-11-25' }), dueDate: '2026-11-20' };
    const { byDay, undated } = itemsByDay([own, item('sem', {})], DUE_SOURCE);
    expect(byDay.get('2026-11-20')?.map((one) => one.id)).toEqual(['prazo']);
    expect(undated.map((one) => one.id)).toEqual(['sem']);
    const text: FieldLike = { id: 'obs', name: 'Obs', kind: 'text', config: {} };
    expect(dateSources([text, due, when]).map((source) => source.name)).toEqual([
      'Prazo',
      'Início',
      'Entrega',
      'Reunião',
    ]);
  });
});
