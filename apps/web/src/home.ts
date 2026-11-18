import { MAX_HOME_PINS } from '@cerebro/shared';
import type { HomeDue, HomeItem, Tree } from './api.js';

/*
 * The start page as plain data: the person's items in the order they press,
 * and the pinned lists as an ordered choice they can change.
 */

export const HOME_GROUPS: readonly { due: HomeDue; title: string }[] = [
  { due: 'overdue', title: 'Atrasados' },
  { due: 'today', title: 'Vencem hoje' },
  { due: 'week', title: 'Nos próximos 7 dias' },
  { due: 'later', title: 'Mais adiante ou sem prazo' },
];

/** The groups that have items, in the order above; items keep the server's order. */
export function groupItems(
  items: readonly HomeItem[],
): { due: HomeDue; title: string; items: HomeItem[] }[] {
  return HOME_GROUPS.map((group) => ({
    ...group,
    items: items.filter((item) => item.due === group.due),
  })).filter((group) => group.items.length > 0);
}

/** The pins with one moved a place up (-1) or down (+1); unchanged at the ends. */
export function movePin(pins: readonly string[], listId: string, step: -1 | 1): string[] {
  const next = [...pins];
  const from = next.indexOf(listId);
  const to = from + step;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to] ?? listId, listId];
  return next;
}

export function unpin(pins: readonly string[], listId: string): string[] {
  return pins.filter((pinned) => pinned !== listId);
}

/** Pinned last, unless the page is full. */
export function pin(pins: readonly string[], listId: string): string[] {
  if (pins.includes(listId) || pins.length >= MAX_HOME_PINS) return [...pins];
  return [...pins, listId];
}

/** "Espaço / Pasta / Lista": where a list sits, so two lists with one name are told apart. */
export function listPlace(tree: Tree, listId: string): string | null {
  const list = tree.lists.find((candidate) => candidate.id === listId);
  if (list === undefined) return null;
  const space = tree.spaces.find((candidate) => candidate.id === list.spaceId);
  const folder =
    list.folderId === null
      ? undefined
      : tree.folders.find((candidate) => candidate.id === list.folderId);
  return [space?.name, folder?.name, list.name].filter((part) => part !== undefined).join(' / ');
}

/** The lists that can still be pinned, by where they sit. */
export function pinChoices(tree: Tree, pins: readonly string[]): { id: string; label: string }[] {
  return tree.lists
    .filter((list) => !pins.includes(list.id))
    .map((list) => ({ id: list.id, label: listPlace(tree, list.id) ?? list.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}
