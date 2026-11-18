import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';

/*
 * A person's notifications, written by the database. Each is read only by
 * its recipient and only while they still see the item; the recipient marks
 * them read.
 */

export type NotificationKind =
  'mentioned' | 'assigned' | 'commented' | 'due_today' | 'overdue' | 'automation';

export interface NotificationView {
  id: number;
  kind: NotificationKind;
  itemId: string;
  itemTitle: string;
  listId: string;
  commentId: string | null;
  actorId: string | null;
  actorName: string | null;
  dueOn: string | null;
  createdAt: Date;
  readAt: Date | null;
  /** Set when a rule caused it, acting as `actorId`; the name is gone with the rule. */
  automation: { id: string; name: string | null } | null;
}

const PAGE = 50;

/** The caller's own, newest first. The database knows who the caller is. */
export async function listNotifications(
  tx: Tx,
  before: number | undefined,
): Promise<NotificationView[]> {
  return rows<NotificationView>(tx, {
    text: `SELECT id::int AS id, kind, item_id AS "itemId", item_title AS "itemTitle",
                  list_id AS "listId", comment_id AS "commentId", actor AS "actorId",
                  actor_name AS "actorName", due_on::text AS "dueOn", created_at AS "createdAt",
                  read_at AS "readAt",
                  CASE WHEN automation_id IS NULL THEN NULL
                       ELSE json_build_object('id', automation_id, 'name', automation_name)
                  END AS automation
           FROM app.my_notifications($1, $2)`,
    values: [before ?? null, PAGE],
  });
}

export async function unreadNotifications(tx: Tx): Promise<{ unread: number }> {
  const found = await one<{ unread: number }>(
    tx,
    sql`SELECT app.my_unread_notifications() AS unread`,
  );
  return { unread: found?.unread ?? 0 };
}

/** Marks the given notifications, or every one, as read. Only the caller's own. */
export async function readNotifications(
  tx: Tx,
  actor: Actor,
  body: { ids?: number[] | undefined },
): Promise<{ read: number }> {
  const read = await run(
    tx,
    sql`UPDATE app.notifications SET read_at = now()
        WHERE user_id = ${actor.userId} AND read_at IS NULL
          AND (${body.ids ?? null}::bigint[] IS NULL OR id = ANY (${body.ids ?? null}::bigint[]))`,
  );
  return { read };
}

/** Reminders for what is due today or late. Run every hour; each is made once. */
export async function notifyDue(db: Tx): Promise<number> {
  const result = await one<{ made: number }>(db, sql`SELECT app.notify_due() AS made`);
  return result?.made ?? 0;
}
