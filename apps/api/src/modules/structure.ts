import { randomUUID } from 'node:crypto';
import {
  levelAtLeast,
  resolveListAccess,
  type AccessLevel,
  type ItemScope,
  type ResolvedAccess,
} from '@cerebro/shared';
import { requireOwner, type Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { forbidden, notFound, stepUpRequired } from '../http/errors.js';
import { accessToList, accessToScope, loadOwnGrants, type ListInfo } from './access.js';

/*
 * The minimum structure needed to exercise permissions end to end in this
 * phase. Statuses, custom fields, views and the rest arrive in later phases.
 *
 * New rows get their id from the API and are read back with a separate
 * SELECT: visibility checks cannot see a row within the statement that
 * inserts it, so INSERT ... RETURNING would be refused.
 */

export interface TreeView {
  spaces: { id: string; name: string; position: number }[];
  folders: { id: string; spaceId: string; name: string; position: number }[];
  lists: {
    id: string;
    spaceId: string;
    folderId: string | null;
    name: string;
    position: number;
    isSensitive: boolean;
    level: AccessLevel;
    itemScope: ItemScope;
  }[];
}

/** Everything the person can navigate to, and nothing else. */
export async function tree(tx: Tx, actor: Actor): Promise<TreeView> {
  const grants = await loadOwnGrants(tx, actor);
  const spaces = await rows<{ id: string; name: string; position: number }>(
    tx,
    sql`SELECT id, name, position FROM app.spaces WHERE NOT is_archived ORDER BY position, name`,
  );
  const folders = await rows<{ id: string; space_id: string; name: string; position: number }>(
    tx,
    sql`SELECT id, space_id, name, position FROM app.folders
        WHERE NOT is_archived ORDER BY position, name`,
  );
  const lists = await rows<{
    id: string;
    space_id: string;
    folder_id: string | null;
    name: string;
    position: number;
    is_sensitive: boolean;
  }>(
    tx,
    sql`SELECT id, space_id, folder_id, name, position, is_sensitive FROM app.lists
        WHERE NOT is_archived ORDER BY position, name`,
  );

  return {
    spaces,
    folders: folders.map((f) => ({
      id: f.id,
      spaceId: f.space_id,
      name: f.name,
      position: f.position,
    })),
    lists: lists
      .map((l) => {
        const access = resolveListAccess(actor.role, grants, {
          listId: l.id,
          folderId: l.folder_id,
          spaceId: l.space_id,
        });
        return {
          id: l.id,
          spaceId: l.space_id,
          folderId: l.folder_id,
          name: l.name,
          position: l.position,
          isSensitive: l.is_sensitive,
          level: access.level,
          itemScope: access.itemScope,
        };
      })
      .filter((l) => levelAtLeast(l.level, 'view')),
  };
}

export async function createSpace(
  tx: Tx,
  actor: Actor,
  body: { name: string },
): Promise<{ id: string; name: string }> {
  requireOwner(actor);
  const id = randomUUID();
  await run(tx, sql`INSERT INTO app.spaces (id, name) VALUES (${id}, ${body.name})`);
  return { id, name: body.name };
}

export async function createFolder(
  tx: Tx,
  actor: Actor,
  body: { spaceId: string; name: string },
): Promise<{ id: string; spaceId: string; name: string }> {
  const access = await accessToScope(tx, actor, 'space', body.spaceId);
  if (!access) throw notFound();
  if (access.level !== 'manage') throw forbidden();
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.folders (id, space_id, name) VALUES (${id}, ${body.spaceId}, ${body.name})`,
  );
  return { id, spaceId: body.spaceId, name: body.name };
}

export async function createList(
  tx: Tx,
  actor: Actor,
  body: {
    spaceId: string;
    folderId?: string | null | undefined;
    name: string;
    isSensitive?: boolean | undefined;
  },
): Promise<ListInfo> {
  const folderId = body.folderId ?? null;
  const access =
    folderId === null
      ? await accessToScope(tx, actor, 'space', body.spaceId)
      : await accessToScope(tx, actor, 'folder', folderId);
  if (!access) throw notFound();
  if (access.level !== 'manage') throw forbidden();

  const id = randomUUID();
  const isSensitive = body.isSensitive ?? false;
  await run(
    tx,
    sql`INSERT INTO app.lists (id, space_id, folder_id, name, is_sensitive)
        VALUES (${id}, ${body.spaceId}, ${folderId}, ${body.name}, ${isSensitive})`,
  );
  return { id, spaceId: body.spaceId, folderId, name: body.name, isSensitive };
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface ItemView {
  id: string;
  listId: string;
  title: string;
  description: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  assignees: string[];
}

interface ItemRow {
  id: string;
  list_id: string;
  title: string;
  description: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  assignees: string[];
}

function toItem(row: ItemRow): ItemView {
  return {
    id: row.id,
    listId: row.list_id,
    title: row.title,
    description: row.description,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assignees: row.assignees,
  };
}

const ITEM_COLUMNS = `i.id, i.list_id, i.title, i.description, i.created_by, i.created_at, i.updated_at,
  coalesce((SELECT array_agg(ia.user_id ORDER BY ia.assigned_at)
            FROM app.item_assignees ia WHERE ia.item_id = i.id), '{}'::uuid[]) AS assignees`;

/** Opens a list for the caller, or explains why not, without leaking its existence. */
async function openList(
  tx: Tx,
  actor: Actor,
  listId: string,
  minimum: AccessLevel,
): Promise<{ list: ListInfo; access: ResolvedAccess }> {
  const found = await accessToList(tx, actor, listId);
  if (!found || !levelAtLeast(found.access.level, 'view')) throw notFound();
  if (!levelAtLeast(found.access.level, minimum)) throw forbidden();
  if (found.list.isSensitive && !actor.stepUp) throw stepUpRequired();
  return found;
}

export async function listItems(tx: Tx, actor: Actor, listId: string): Promise<ItemView[]> {
  const { list, access } = await openList(tx, actor, listId, 'view');
  const seesAll = access.itemScope === 'all';
  const found = await rows<ItemRow>(tx, {
    text: `SELECT ${ITEM_COLUMNS} FROM app.items i
           WHERE i.list_id = $1
             AND ($2::boolean OR i.created_by = $3 OR EXISTS (
               SELECT 1 FROM app.item_assignees mine
               WHERE mine.item_id = i.id AND mine.user_id = $3))
           ORDER BY i.created_at DESC, i.id
           LIMIT 500`,
    values: [listId, seesAll, actor.userId],
  });
  if (list.isSensitive) {
    await run(tx, sql`SELECT audit.record('list.sensitive_viewed', 'list', ${listId})`);
  }
  return found.map(toItem);
}

async function getItem(tx: Tx, itemId: string): Promise<ItemView | undefined> {
  const row = await one<ItemRow>(tx, {
    text: `SELECT ${ITEM_COLUMNS} FROM app.items i WHERE i.id = $1`,
    values: [itemId],
  });
  return row ? toItem(row) : undefined;
}

export async function createItem(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: { title: string; description?: string | undefined },
): Promise<ItemView> {
  await openList(tx, actor, listId, 'edit');
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.items (id, list_id, title, description, created_by)
        VALUES (${id}, ${listId}, ${body.title}, ${body.description ?? ''}, ${actor.userId})`,
  );
  const item = await getItem(tx, id);
  if (!item) throw forbidden();
  return item;
}

/** The item and the caller's access to it, when the caller can see it at all. */
async function openItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  minimum: AccessLevel,
): Promise<{ item: ItemView; access: ResolvedAccess }> {
  const item = await getItem(tx, itemId);
  if (!item) throw notFound();
  const { access } = await openList(tx, actor, item.listId, minimum);
  const theirs = item.createdBy === actor.userId || item.assignees.includes(actor.userId);
  if (access.itemScope !== 'all' && !theirs) throw notFound();
  return { item, access };
}

export async function updateItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: { title?: string | undefined; description?: string | undefined },
): Promise<ItemView> {
  await openItem(tx, actor, itemId, 'edit');
  const changed = await run(
    tx,
    sql`UPDATE app.items SET
          title = coalesce(${body.title ?? null}, title),
          description = coalesce(${body.description ?? null}, description)
        WHERE id = ${itemId}`,
  );
  if (changed !== 1) throw forbidden();
  const item = await getItem(tx, itemId);
  if (!item) throw notFound();
  return item;
}

/** Replaces who an item is assigned to. Only for people who see the whole list. */
export async function setAssignees(
  tx: Tx,
  actor: Actor,
  itemId: string,
  userIds: readonly string[],
): Promise<ItemView> {
  const { item, access } = await openItem(tx, actor, itemId, 'edit');
  if (access.itemScope !== 'all') throw forbidden();

  const wanted = new Set(userIds);
  for (const current of item.assignees) {
    if (!wanted.has(current)) {
      await run(
        tx,
        sql`DELETE FROM app.item_assignees WHERE item_id = ${itemId} AND user_id = ${current}`,
      );
    }
  }
  for (const userId of wanted) {
    if (!item.assignees.includes(userId)) {
      await run(
        tx,
        sql`INSERT INTO app.item_assignees (item_id, user_id) VALUES (${itemId}, ${userId})`,
      );
    }
  }
  await run(
    tx,
    sql`SELECT audit.record('item.assignees_changed', 'item', ${itemId},
                            ${JSON.stringify({ assignees: [...wanted] })}::jsonb)`,
  );
  const updated = await getItem(tx, itemId);
  if (!updated) throw notFound();
  return updated;
}
