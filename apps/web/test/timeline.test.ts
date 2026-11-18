import { describe, expect, it } from 'vitest';
import type { Item } from '../src/api.js';
import type { FieldLike } from '../src/fieldvalues.js';
import { DUE_SOURCE, START_SOURCE } from '../src/calendar.js';
import { addDays, barIn, daysBetween, spanOf, weekStart, windowDays } from '../src/timeline.js';

const start: FieldLike = { id: 'comeca', name: 'Começa', kind: 'date', config: {} };
const end: FieldLike = { id: 'fim', name: 'Fim', kind: 'date', config: {} };
const item = (fields: Item['fields']): Item => ({
  id: 'x',
  listId: 'lista',
  title: 'x',
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
  trashedAt: null,
  trashedBy: null,
});

describe('days on the timeline', () => {
  it('count by the calendar, across months and the change of daylight saving', () => {
    expect(daysBetween('2026-10-31', '2026-11-01')).toBe(1);
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    // Brazil had daylight saving starting on the first Sunday of November until 2019.
    expect(daysBetween('2018-11-03', '2018-11-05')).toBe(2);
  });

  it('start weeks on Monday and cover whole windows', () => {
    expect(weekStart('2026-11-18')).toBe('2026-11-16');
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(weekStart('2026-11-22')).toBe('2026-11-16');
    const days = windowDays('2026-11-16', 42);
    expect(days).toHaveLength(42);
    expect(days.at(-1)).toBe('2026-12-27');
  });
});

describe('an item’s bar', () => {
  it('runs from its start to its end, or marks a single day', () => {
    expect(spanOf(item({ comeca: '2026-11-17', fim: '2026-11-20' }), start, end)).toEqual({
      start: '2026-11-17',
      end: '2026-11-20',
    });
    expect(spanOf(item({ fim: '2026-11-20' }), start, end)).toEqual({
      start: '2026-11-20',
      end: '2026-11-20',
    });
    expect(spanOf(item({ comeca: '2026-11-25', fim: '2026-11-20' }), start, end)).toEqual({
      start: '2026-11-20',
      end: '2026-11-25',
    });
    expect(spanOf(item({}), start, end)).toBeNull();
  });

  it('runs from the item’s own start to its due date', () => {
    const own = { ...item({}), startDate: '2026-11-18', dueDate: '2026-11-22' };
    expect(spanOf(own, START_SOURCE, DUE_SOURCE)).toEqual({
      start: '2026-11-18',
      end: '2026-11-22',
    });
    expect(spanOf({ ...own, startDate: null }, START_SOURCE, DUE_SOURCE)).toEqual({
      start: '2026-11-22',
      end: '2026-11-22',
    });
  });

  it('sits in the window where its days are, cut at the edges, and not at all outside', () => {
    const first = '2026-11-16';
    expect(barIn({ start: '2026-11-17', end: '2026-11-20' }, first, 42)).toEqual({
      column: 1,
      days: 4,
      clippedStart: false,
      clippedEnd: false,
    });
    expect(barIn({ start: '2026-11-01', end: '2026-11-17' }, first, 42)).toEqual({
      column: 0,
      days: 2,
      clippedStart: true,
      clippedEnd: false,
    });
    expect(barIn({ start: '2026-12-27', end: '2027-01-10' }, first, 42)).toMatchObject({
      column: 41,
      days: 1,
      clippedEnd: true,
    });
    expect(barIn({ start: '2026-10-01', end: '2026-10-02' }, first, 42)).toBeNull();
    expect(barIn({ start: '2026-12-28', end: '2026-12-28' }, first, 42)).toBeNull();
  });
});
