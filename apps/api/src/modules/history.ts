import type { Actor } from '../actor.js';
import { rows, type Tx } from '../db.js';
import { openItem } from './structure.js';

/*
 * What happened to an item, read back. Every line was written by the database
 * when the change was made; this module only reads, and the database decides
 * which lines the caller may see.
 */

export type ItemChangeKind =
  'created' | 'title' | 'description' | 'list' | 'stage' | 'assigned' | 'unassigned' | 'field';

export interface ItemChangeView {
  id: number;
  at: Date;
  /** Null when the change was not made by a signed-in person. */
  actor: string | null;
  what: ItemChangeKind;
  /** Set when a custom field changed. */
  fieldId: string | null;
  old: unknown;
  new: unknown;
}

/** The changes of an item, newest first. `before` continues from an earlier page. */
export async function itemHistory(
  tx: Tx,
  actor: Actor,
  itemId: string,
  query: { before?: number | undefined; limit: number },
): Promise<ItemChangeView[]> {
  await openItem(tx, actor, itemId, 'view');
  const found = await rows<{
    id: string;
    at: Date;
    actor: string | null;
    what: ItemChangeKind;
    field_id: string | null;
    old: unknown;
    new: unknown;
  }>(tx, {
    text: `SELECT id, at, actor, what, field_id, old, new FROM app.item_changes
           WHERE item_id = $1 AND ($2::bigint IS NULL OR id < $2::bigint)
           ORDER BY id DESC LIMIT $3`,
    values: [itemId, query.before ?? null, query.limit],
  });
  return found.map((row) => ({
    id: Number(row.id),
    at: row.at,
    actor: row.actor,
    what: row.what,
    fieldId: row.field_id,
    old: row.old,
    new: row.new,
  }));
}
