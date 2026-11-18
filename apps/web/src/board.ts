import type { Item, Stage } from './api.js';

/*
 * The board's arithmetic, kept apart from the screen so it can be tested:
 * which items sit in which column and in what order, where a dragged card
 * would land, and when the board should scroll under the finger.
 */

export interface BoardColumn {
  stage: Stage;
  items: Item[];
}

/**
 * One column per stage, in the list's order. Inside a column, items keep the
 * order they were given in: the list's chosen order (by default, whoever has
 * been waiting longest in their stage first).
 */
export function columnsOf(stages: readonly Stage[], items: readonly Item[]): BoardColumn[] {
  return stages.map((stage) => ({
    stage,
    items: items.filter((item) => item.stageId === stage.id),
  }));
}

/** The stage a card is over, read from the elements under the pointer, top first. */
export function stageUnder(
  elements: readonly {
    closest: (selector: string) => { getAttribute: (name: string) => string | null } | null;
  }[],
): string | null {
  for (const element of elements) {
    const column = element.closest('[data-stage-id]');
    const id = column?.getAttribute('data-stage-id');
    if (id) return id;
  }
  return null;
}

/** A drop that changes something: onto another stage of the same list. */
export function dropTarget(
  from: string,
  over: string | null,
  stages: readonly Stage[],
): string | null {
  if (over === null || over === from) return null;
  return stages.some((stage) => stage.id === over) ? over : null;
}

/** Near an edge while dragging, the board scrolls that way; faster the closer it gets. */
export const EDGE = 48;
export function edgeScroll(x: number, left: number, right: number): number {
  if (x < left + EDGE) return -Math.ceil(((left + EDGE - x) / EDGE) * 16);
  if (x > right - EDGE) return Math.ceil(((x - (right - EDGE)) / EDGE) * 16);
  return 0;
}

/** The item as it is right after a move, shown before the server confirms it. */
export function moved(item: Item, stageId: string, now: number): Item {
  return { ...item, stageId, stageSince: new Date(now).toISOString() };
}
