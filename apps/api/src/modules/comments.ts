import { randomUUID } from 'node:crypto';
import { levelAtLeast, type ResolvedAccess } from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { openItem } from './structure.js';

/*
 * Comments on an item: read by whoever sees it, written by whoever edits it.
 * Only the author changes a comment, and earlier versions stay readable. The
 * author or a manager of the list removes one, and then nobody reads what it
 * said. The database holds every one of these rules too.
 */

export interface CommentView {
  id: string;
  itemId: string;
  authorId: string;
  /** Empty once removed. */
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  removedAt: Date | null;
  removedBy: string | null;
  /** How many earlier versions there are to read. */
  versions: number;
  /** People mentioned in it; empty once removed. */
  mentions: string[];
  /** What the caller may do with it. */
  canEdit: boolean;
  canRemove: boolean;
}

interface CommentRow {
  id: string;
  item_id: string;
  author_id: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  versions: number;
  mentions: string[];
}

/** What the caller may do with a comment: the same rules the database holds. */
function toComment(row: CommentRow, actor: Actor, access: ResolvedAccess): CommentView {
  const live = row.deleted_at === null;
  const authorAtWork = row.author_id === actor.userId && levelAtLeast(access.level, 'edit');
  return {
    ...shape(row),
    canEdit: live && authorAtWork,
    canRemove: live && (authorAtWork || access.level === 'manage'),
  };
}

const shape = (row: CommentRow): Omit<CommentView, 'canEdit' | 'canRemove'> => ({
  id: row.id,
  itemId: row.item_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  removedAt: row.deleted_at,
  removedBy: row.deleted_by,
  versions: row.deleted_at === null ? row.versions : 0,
  mentions: row.deleted_at === null ? row.mentions : [],
});

const COLUMNS = `c.id, c.item_id, c.author_id, c.body, c.created_at, c.edited_at, c.deleted_at,
  c.deleted_by,
  (SELECT count(*)::int FROM app.item_comment_versions v WHERE v.comment_id = c.id) AS versions,
  coalesce((SELECT array_agg(m.user_id ORDER BY m.created_at, m.user_id)
            FROM app.comment_mentions m WHERE m.comment_id = c.id), '{}'::uuid[]) AS mentions`;

export async function listComments(tx: Tx, actor: Actor, itemId: string): Promise<CommentView[]> {
  const { access } = await openItem(tx, actor, itemId, 'view');
  const found = await rows<CommentRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_comments c
           WHERE c.item_id = $1 ORDER BY c.created_at, c.id LIMIT 1000`,
    values: [itemId],
  });
  return found.map((row) => toComment(row, actor, access));
}

export async function addComment(
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: { body: string; mentions?: string[] | undefined },
): Promise<CommentView> {
  const { access } = await openItem(tx, actor, itemId, 'edit');
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.item_comments (id, item_id, body) VALUES (${id}, ${itemId}, ${body.body})`,
  );
  await mention(tx, itemId, id, body.mentions ?? []);
  return toComment(await findComment(tx, id), actor, access);
}

async function findComment(tx: Tx, commentId: string): Promise<CommentRow> {
  const found = await one<CommentRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_comments c WHERE c.id = $1`,
    values: [commentId],
  });
  if (!found) throw notFound();
  return found;
}

/** Changes what a comment says. Only its author, while they may still edit the item. */
export async function editComment(
  tx: Tx,
  actor: Actor,
  commentId: string,
  body: { body: string; mentions?: string[] | undefined },
): Promise<CommentView> {
  const comment = await findComment(tx, commentId);
  if (comment.deleted_at !== null) throw badRequest('comment_removed');
  if (comment.author_id !== actor.userId) throw forbidden();
  const { access } = await openItem(tx, actor, comment.item_id, 'edit');
  await run(tx, sql`UPDATE app.item_comments SET body = ${body.body} WHERE id = ${commentId}`);
  // Mentions made stay made; editing can only name more people.
  await mention(tx, comment.item_id, commentId, body.mentions ?? []);
  return toComment(await findComment(tx, commentId), actor, access);
}

/** Removes a comment: its author, or whoever manages the list. */
export async function removeComment(tx: Tx, actor: Actor, commentId: string): Promise<CommentView> {
  const comment = await findComment(tx, commentId);
  if (comment.deleted_at !== null) throw badRequest('comment_removed');
  const { access } = await openItem(tx, actor, comment.item_id, 'view');
  const authorAtWork = comment.author_id === actor.userId && levelAtLeast(access.level, 'edit');
  if (!authorAtWork && access.level !== 'manage') throw forbidden();
  const changed = await run(
    tx,
    sql`UPDATE app.item_comments SET deleted_at = now() WHERE id = ${commentId}`,
  );
  if (changed !== 1) throw forbidden();
  return toComment(await findComment(tx, commentId), actor, access);
}

export interface CommentVersion {
  body: string;
  replacedAt: Date;
}

/** What a comment said before each change, oldest first. Nothing once it is removed. */
export async function commentVersions(
  tx: Tx,
  actor: Actor,
  commentId: string,
): Promise<CommentVersion[]> {
  const comment = await findComment(tx, commentId);
  await openItem(tx, actor, comment.item_id, 'view');
  return rows<CommentVersion>(tx, {
    text: `SELECT body, replaced_at AS "replacedAt" FROM app.item_comment_versions
           WHERE comment_id = $1 ORDER BY id`,
    values: [commentId],
  });
}

/** The people of an item: who can see it, and who took part in its comments. */
export interface ItemPerson {
  id: string;
  name: string;
  /** Can see the item now, so can be mentioned on it. */
  seesItem: boolean;
}

export async function itemPeople(tx: Tx, actor: Actor, itemId: string): Promise<ItemPerson[]> {
  await openItem(tx, actor, itemId, 'view');
  return rows<ItemPerson>(tx, {
    text: `SELECT id, name, sees_item AS "seesItem" FROM app.item_people($1)`,
    values: [itemId],
  });
}

/** Names people in a comment. Each must be able to see the item (the database checks it too). */
async function mention(tx: Tx, itemId: string, commentId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const able = await rows<{ id: string }>(tx, {
    text: `SELECT id FROM app.item_people($1) WHERE sees_item`,
    values: [itemId],
  });
  const seeing = new Set(able.map((person) => person.id));
  if (!ids.every((id) => seeing.has(id))) throw badRequest('cannot_mention');
  await run(
    tx,
    sql`INSERT INTO app.comment_mentions (comment_id, user_id)
        SELECT ${commentId}, person FROM unnest(${ids}::uuid[]) AS person
        ON CONFLICT DO NOTHING`,
  );
}
