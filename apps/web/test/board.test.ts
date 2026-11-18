import { describe, expect, it } from 'vitest';
import type { Item, Stage } from '../src/api.js';
import {
  columnsOf,
  dropTarget,
  EDGE,
  edgeScroll,
  indexAt,
  moved,
  placeAt,
  placed,
  stageUnder,
} from '../src/board.js';

const stage = (id: string, position: number): Stage => ({
  id,
  listId: 'lista',
  entryRole: null,
  name: id,
  color: '#58b98a',
  kind: 'open',
  position,
});
const STAGES = [stage('a-fazer', 0), stage('fazendo', 1), stage('feito', 2)];
const item = (id: string, stageId: string, since: string): Item => ({
  id,
  listId: 'lista',
  title: id,
  description: '',
  createdBy: 'ana',
  createdAt: since,
  updatedAt: since,
  assignees: [],
  stageId,
  stageSince: since,
  fields: {},
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

describe('the columns of a board', () => {
  it('follow the stages in order, keeping the order the items were given in', () => {
    const columns = columnsOf(STAGES, [
      item('novo', 'a-fazer', '2026-11-18T10:00:00Z'),
      item('antigo', 'a-fazer', '2026-11-17T10:00:00Z'),
      item('andando', 'fazendo', '2026-11-18T09:00:00Z'),
    ]);
    expect(columns.map((column) => column.stage.id)).toEqual(['a-fazer', 'fazendo', 'feito']);
    expect(columns[0]?.items.map((one) => one.id)).toEqual(['novo', 'antigo']);
    expect(columns[2]?.items).toEqual([]);
  });
});

describe('dropping a card', () => {
  it('moves it only onto another stage of the same list', () => {
    expect(dropTarget('a-fazer', 'fazendo', STAGES)).toBe('fazendo');
    expect(dropTarget('a-fazer', 'a-fazer', STAGES)).toBeNull();
    expect(dropTarget('a-fazer', null, STAGES)).toBeNull();
    expect(dropTarget('a-fazer', 'de-outra-lista', STAGES)).toBeNull();
  });

  it('finds the column under the pointer, whatever part of it is there', () => {
    const inside = (id: string | null) => ({
      closest: () => (id === null ? null : { getAttribute: () => id }),
    });
    expect(stageUnder([inside(null), inside('feito'), inside('fazendo')])).toBe('feito');
    expect(stageUnder([inside(null)])).toBeNull();
  });

  it('shows the card in its new stage right away, as just arrived', () => {
    const now = Date.parse('2026-11-18T12:00:00Z');
    const after = moved(item('x', 'a-fazer', '2026-11-01T00:00:00Z'), 'feito', now);
    expect(after.stageId).toBe('feito');
    expect(after.stageSince).toBe('2026-11-18T12:00:00.000Z');
  });
});

describe('dragging near an edge', () => {
  it('scrolls the board that way, faster closer to the edge, and not at all in the middle', () => {
    expect(edgeScroll(500, 0, 1000)).toBe(0);
    expect(edgeScroll(EDGE, 0, 1000)).toBe(0);
    expect(edgeScroll(0, 0, 1000)).toBe(-16);
    expect(edgeScroll(EDGE / 2, 0, 1000)).toBe(-8);
    expect(edgeScroll(1000, 0, 1000)).toBe(16);
  });
});

describe('placing a card by hand', () => {
  it('lands where the pointer is among the other cards', () => {
    const middles = [100, 200, 300];
    expect(indexAt(50, middles)).toBe(0);
    expect(indexAt(150, middles)).toBe(1);
    expect(indexAt(350, middles)).toBe(3);
  });

  it('moves one card, or brings one in, keeping the others in order', () => {
    expect(placeAt(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(placeAt(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(placeAt(['a', 'b'], 'novo', 1)).toEqual(['a', 'novo', 'b']);
    expect(placeAt(['a', 'b'], 'novo', 99)).toEqual(['a', 'b', 'novo']);
    expect(placeAt(['a', 'b'], 'a', -3)).toEqual(['a', 'b']);
  });

  it('shows the new places at once, and leaves other items alone', () => {
    const items = [
      item('a', 'a-fazer', '2026-11-01T00:00:00Z'),
      item('b', 'a-fazer', '2026-11-02T00:00:00Z'),
      item('x', 'feito', '2026-11-03T00:00:00Z'),
    ];
    const after = placed(items, ['b', 'a']);
    expect(after.map((one) => [one.id, one.position])).toEqual([
      ['a', 2048],
      ['b', 1024],
      ['x', null],
    ]);
  });
});
