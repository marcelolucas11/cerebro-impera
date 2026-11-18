import { randomUUID } from 'node:crypto';
import {
  DEFAULT_STAGES,
  levelAtLeast,
  resolveListAccess,
  type AccessLevel,
  type FieldValue,
  type ItemScope,
  type ResolvedAccess,
  type StageDraft,
} from '@cerebro/shared';
import { requireOwner, type Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound, stepUpRequired } from '../http/errors.js';
import { accessToList, accessToScope, loadOwnGrants, type ListInfo } from './access.js';
import { writeFieldValues } from './field-values.js';

/*
 * Spaces, folders, lists and items, and who may open each of them. Stages and
 * custom fields have their own modules.
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
    stages?: readonly StageDraft[] | undefined;
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
  // A list is never without stages: it is born with the chosen set or the default one.
  for (const [position, stage] of (body.stages ?? DEFAULT_STAGES).entries()) {
    await run(
      tx,
      sql`INSERT INTO app.list_stages (id, list_id, name, color, kind, position)
          VALUES (${randomUUID()}, ${id}, ${stage.name}, ${stage.color}, ${stage.kind}, ${position})`,
    );
  }
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
  stageId: string;
  /** Since when the item is in its current stage. */
  stageSince: Date;
  /** Values of the list's custom fields, by field id. A field with no value is absent. */
  fields: Record<string, FieldValue>;
  /** When the item was sent to the trash, and by whom; null for an item in use. */
  trashedAt: Date | null;
  trashedBy: string | null;
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
  stage_id: string;
  stage_since: Date;
  fields: Record<string, FieldValue>;
  deleted_at: Date | null;
  deleted_by: string | null;
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
    stageId: row.stage_id,
    stageSince: row.stage_since,
    fields: row.fields,
    trashedAt: row.deleted_at,
    trashedBy: row.deleted_by,
  };
}

const ITEM_COLUMNS = `i.id, i.list_id, i.title, i.description, i.created_by, i.created_at, i.updated_at,
  i.stage_id, i.stage_since, i.deleted_at, i.deleted_by,
  coalesce((SELECT array_agg(ia.user_id ORDER BY ia.assigned_at)
            FROM app.item_assignees ia WHERE ia.item_id = i.id), '{}'::uuid[]) AS assignees,
  coalesce((SELECT jsonb_object_agg(v.field_id, v.value)
            FROM app.item_field_values v WHERE v.item_id = i.id), '{}'::jsonb) AS fields`;

/** Opens a list for the caller, or explains why not, without leaking its existence. */
export async function openList(
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
           WHERE i.list_id = $1 AND i.deleted_at IS NULL
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
  body: {
    title: string;
    description?: string | undefined;
    stageId?: string | undefined;
    fields?: Readonly<Record<string, FieldValue | null>> | undefined;
  },
): Promise<ItemView> {
  await openList(tx, actor, listId, 'edit');
  if (body.stageId !== undefined) await requireStageOf(tx, listId, body.stageId);
  const id = randomUUID();
  // Without a chosen stage, the database puts the item in the list's first one.
  await run(
    tx,
    sql`INSERT INTO app.items (id, list_id, title, description, created_by, stage_id)
        VALUES (${id}, ${listId}, ${body.title}, ${body.description ?? ''}, ${actor.userId},
                ${body.stageId ?? null})`,
  );
  if (body.fields !== undefined) await writeFieldValues(tx, listId, id, body.fields);
  const item = await getItem(tx, id);
  if (!item) throw forbidden();
  return item;
}

/** A stage can only be used on items of its own list. */
async function requireStageOf(tx: Tx, listId: string, stageId: string): Promise<void> {
  const stage = await one(
    tx,
    sql`SELECT 1 FROM app.list_stages WHERE id = ${stageId} AND list_id = ${listId}`,
  );
  if (!stage) throw badRequest('invalid_stage');
}

/** The item and the caller's access to it, when the caller can see it at all. */
export async function openItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  minimum: AccessLevel,
  options: { inTrash?: boolean } = {},
): Promise<{ item: ItemView; access: ResolvedAccess }> {
  const item = await getItem(tx, itemId);
  if (!item) throw notFound();
  // An item in the trash exists only for the trash; anywhere else it is gone.
  if (item.trashedAt !== null && options.inTrash !== true) throw notFound();
  const { access } = await openList(tx, actor, item.listId, minimum);
  const theirs = item.createdBy === actor.userId || item.assignees.includes(actor.userId);
  if (access.itemScope !== 'all' && !theirs) throw notFound();
  if (item.trashedAt === null && options.inTrash === true) throw conflict('not_in_trash');
  return { item, access };
}

export async function updateItem(
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: {
    title?: string | undefined;
    description?: string | undefined;
    stageId?: string | undefined;
    fields?: Readonly<Record<string, FieldValue | null>> | undefined;
  },
): Promise<ItemView> {
  const { item: current } = await openItem(tx, actor, itemId, 'edit');
  if (body.stageId !== undefined) await requireStageOf(tx, current.listId, body.stageId);
  const changed = await run(
    tx,
    sql`UPDATE app.items SET
          title = coalesce(${body.title ?? null}, title),
          description = coalesce(${body.description ?? null}, description),
          stage_id = coalesce(${body.stageId ?? null}::uuid, stage_id)
        WHERE id = ${itemId}`,
  );
  if (changed !== 1) throw forbidden();
  if (body.fields !== undefined) await writeFieldValues(tx, current.listId, itemId, body.fields);
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

/** How long an item stays in the trash before it is removed for good. Enforced by the database. */
export const TRASH_DAYS = 30;

/** Sends an item to the trash. Whoever may edit it may do so; it can be brought back for 30 days. */
export async function trashItem(tx: Tx, actor: Actor, itemId: string): Promise<void> {
  await openItem(tx, actor, itemId, 'edit');
  const changed = await run(tx, sql`UPDATE app.items SET deleted_at = now() WHERE id = ${itemId}`);
  if (changed !== 1) throw forbidden();
}

/** Brings an item back from the trash, as it was, to the list and stage it left. */
export async function restoreItem(tx: Tx, actor: Actor, itemId: string): Promise<ItemView> {
  await openItem(tx, actor, itemId, 'edit', { inTrash: true });
  const changed = await run(tx, sql`UPDATE app.items SET deleted_at = NULL WHERE id = ${itemId}`);
  if (changed !== 1) throw forbidden();
  const item = await getItem(tx, itemId);
  if (!item) throw notFound();
  return item;
}

/** The items of a list in the trash, as far as the caller can see them, most recent first. */
export async function listTrash(tx: Tx, actor: Actor, listId: string): Promise<ItemView[]> {
  const { list, access } = await openList(tx, actor, listId, 'view');
  const found = await rows<ItemRow>(tx, {
    text: `SELECT ${ITEM_COLUMNS} FROM app.items i
           WHERE i.list_id = $1 AND i.deleted_at IS NOT NULL
             AND ($2::boolean OR i.created_by = $3 OR EXISTS (
               SELECT 1 FROM app.item_assignees mine
               WHERE mine.item_id = i.id AND mine.user_id = $3))
           ORDER BY i.deleted_at DESC, i.id
           LIMIT 500`,
    values: [listId, access.itemScope === 'all', actor.userId],
  });
  if (list.isSensitive) {
    await run(tx, sql`SELECT audit.record('list.sensitive_viewed', 'list', ${listId})`);
  }
  return found.map(toItem);
}

/** Removes for good what has been in the trash for longer than the database allows. */
export async function purgeTrash(db: Tx): Promise<number> {
  const result = await one<{ purged: number }>(db, sql`SELECT app.purge_trash() AS purged`);
  return result?.purged ?? 0;
}
