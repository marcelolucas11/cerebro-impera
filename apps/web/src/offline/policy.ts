import type { Home, Tree } from '../api.js';

/*
 * What a device may keep for reading offline: the person's own account, the
 * structure they see, their start page, and the items, stages and fields of
 * lists that are not sensitive. Never anything of a sensitive list, never a
 * secret value (those only ever come through their own request), never a file.
 */

/** Without talking to the server for this long, the device forgets everything. */
export const OFFLINE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

const ALWAYS = new Set(['/api/me', '/api/tree', '/api/home']);
const LIST_PART =
  /^\/api\/lists\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:items|stages|fields)$/;

/** Whether an answer from this address may be kept, given the structure the person sees now. */
export function keepable(path: string, tree: Tree | null): boolean {
  if (ALWAYS.has(path)) return true;
  const list = LIST_PART.exec(path)?.[1];
  if (list === undefined || tree === null) return false;
  const found = tree.lists.find((candidate) => candidate.id === list);
  return found !== undefined && !found.isSensitive;
}

/** The list an address reads from, if it is one of a list's parts. */
export function listOf(path: string): string | undefined {
  return LIST_PART.exec(path)?.[1];
}

/**
 * Whether what was kept from an address must go now that the structure is `next`:
 * its list is gone, became sensitive, or is seen at another level or reach than
 * when it was kept (`before`), so the kept items may show more than she may see.
 */
export function noLongerKeepable(path: string, before: Tree | null, next: Tree): boolean {
  const list = listOf(path);
  if (list === undefined) return false;
  const now = next.lists.find((candidate) => candidate.id === list);
  const then = before?.lists.find((candidate) => candidate.id === list);
  return (
    now === undefined ||
    now.isSensitive ||
    then === undefined ||
    now.level !== then.level ||
    now.itemScope !== then.itemScope
  );
}

/**
 * What of an answer is kept: the structure without the sensitive lists (not even
 * their names), and the start page without anything from a sensitive or unknown list.
 */
export function keptPart(path: string, value: unknown, tree: Tree | null): unknown {
  if (path === '/api/tree') {
    const whole = value as Tree;
    return { ...whole, lists: whole.lists.filter((list) => !list.isSensitive) };
  }
  if (path !== '/api/home') return value;
  const home = value as Home;
  const open = new Set(
    (tree?.lists ?? []).filter((list) => !list.isSensitive).map((list) => list.id),
  );
  return {
    ...home,
    items: home.items.filter((item) => open.has(item.listId)),
    pins: home.pins.filter((pin) => open.has(pin)),
  };
}

export function expired(lastContact: number | null, now: number): boolean {
  return lastContact === null || now - lastContact > OFFLINE_DAYS * DAY_MS;
}
