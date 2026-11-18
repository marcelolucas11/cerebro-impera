import { randomUUID } from 'node:crypto';
import { levelAtLeast } from '@cerebro/shared';
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
}

const toComment = (row: CommentRow): CommentView => ({
  id: row.id,
  itemId: row.item_id,
  authorId: row.author_id,
  body: row.body,
  createdAt: row.created_at,
  editedAt: row.edited_at,
  removedAt: row.deleted_at,
  removedBy: row.deleted_by,
  versions: row.deleted_at === null ? row.versions : 0,
});

const COLUMNS = `c.id, c.item_id, c.author_id, c.body, c.created_at, c.edited_at, c.deleted_at,
  c.deleted_by,
  (SELECT count(*)::int FROM app.item_comment_versions v WHERE v.comment_id = c.id) AS versions`;

export async function listComments(tx: Tx, actor: Actor, itemId: string): Promise<CommentView[]> {
  await openItem(tx, actor, itemId, 'view');
  const found = await rows<CommentRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_comments c
           WHERE c.item_id = $1 ORDER BY c.created_at, c.id LIMIT 1000`,
    values: [itemId],
  });
  return found.map(toComment);
}

export async function addComment(
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: { body: string },
): Promise<CommentView> {
  await openItem(tx, actor, itemId, 'edit');
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.item_comments (id, item_id, body) VALUES (${id}, ${itemId}, ${body.body})`,
  );
  return mustFind(tx, id);
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
  body: { body: string },
): Promise<CommentView> {
  const comment = await findComment(tx, commentId);
  if (comment.deleted_at !== null) throw badRequest('comment_removed');
  if (comment.author_id !== actor.userId) throw forbidden();
  await openItem(tx, actor, comment.item_id, 'edit');
  await run(tx, sql`UPDATE app.item_comments SET body = ${body.body} WHERE id = ${commentId}`);
  return mustFind(tx, commentId);
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
  return mustFind(tx, commentId);
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

async function mustFind(tx: Tx, commentId: string): Promise<CommentView> {
  return toComment(await findComment(tx, commentId));
}
