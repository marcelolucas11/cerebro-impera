import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { notFound } from '../http/errors.js';

/*
 * A person's start page: the unfinished items with them, by when they are
 * due; how many notifications wait; and the lists they pinned, in their
 * order. Everything is read with their own access: an item or list they lose
 * stops showing by itself.
 */

export type DueGroup = 'overdue' | 'today' | 'week' | 'later';

export interface HomeItem {
  id: string;
  title: string;
  listId: string;
  listName: string;
  stageName: string;
  dueDate: string | null;
  priority: number | null;
  due: DueGroup;
}

export interface Home {
  items: HomeItem[];
  unread: number;
  /** Pinned lists the person can still open, in their order. */
  pins: string[];
}

const LIMIT = 200;

export async function homeOf(tx: Tx, actor: Actor): Promise<Home> {
  const items = await rows<HomeItem>(tx, {
    text: `SELECT i.id, i.title, i.list_id AS "listId", l.name AS "listName",
                  s.name AS "stageName", i.due_date::text AS "dueDate", i.priority,
                  CASE WHEN i.due_date < current_date THEN 'overdue'
                       WHEN i.due_date = current_date THEN 'today'
                       WHEN i.due_date <= current_date + 7 THEN 'week'
                       ELSE 'later' END AS due
           FROM app.items i
           JOIN app.lists l ON l.id = i.list_id
           JOIN app.list_stages s ON s.id = i.stage_id
           WHERE i.deleted_at IS NULL
             AND s.kind NOT IN ('done', 'closed')
             AND EXISTS (SELECT 1 FROM app.item_assignees a
                         WHERE a.item_id = i.id AND a.user_id = $1)
           ORDER BY i.due_date NULLS LAST, i.priority NULLS LAST, i.created_at, i.id
           LIMIT ${String(LIMIT)}`,
    values: [actor.userId],
  });
  const unread = await one<{ unread: number }>(
    tx,
    sql`SELECT app.my_unread_notifications() AS unread`,
  );
  const pins = await rows<{ list_id: string }>(
    tx,
    sql`SELECT p.list_id FROM app.home_pins p JOIN app.lists l ON l.id = p.list_id
        ORDER BY p.position`,
  );
  return { items, unread: unread?.unread ?? 0, pins: pins.map((pin) => pin.list_id) };
}

/** Replaces the pinned lists with these, in this order. Only lists the person can open. */
export async function setPins(
  tx: Tx,
  actor: Actor,
  body: { listIds: readonly string[] },
): Promise<Home> {
  const found = await one<{ count: number }>(
    tx,
    sql`SELECT count(*)::int AS count FROM app.lists WHERE id = ANY(${[...body.listIds]}::uuid[])`,
  );
  if ((found?.count ?? 0) !== body.listIds.length) throw notFound();
  await run(tx, sql`DELETE FROM app.home_pins`);
  for (const [position, listId] of body.listIds.entries()) {
    await run(
      tx,
      sql`INSERT INTO app.home_pins (list_id, position) VALUES (${listId}, ${position})`,
    );
  }
  return homeOf(tx, actor);
}
