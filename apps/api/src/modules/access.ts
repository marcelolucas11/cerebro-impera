import {
  resolveFolderAccess,
  resolveListAccess,
  resolveSpaceAccess,
  type AccessGrant,
  type AccessLevel,
  type ItemScope,
  type ResolvedAccess,
  type ScopeType,
} from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, sql, type Tx } from '../db.js';

/*
 * First layer of authorization: decisions made by the API, in TypeScript,
 * from the person's own grants. The database then enforces the same rules
 * again through row-level security, with an independent implementation.
 * Either layer alone is meant to be sufficient.
 */

interface GrantRow {
  space_id: string | null;
  folder_id: string | null;
  list_id: string | null;
  level: AccessLevel;
  item_scope: ItemScope;
}

export async function loadOwnGrants(tx: Tx, actor: Actor): Promise<AccessGrant[]> {
  if (actor.role === 'owner') return [];
  const found = await rows<GrantRow>(
    tx,
    sql`SELECT space_id, folder_id, list_id, level, item_scope
        FROM app.access_grants WHERE user_id = ${actor.userId}`,
  );
  return found.map((row) => ({
    spaceId: row.space_id,
    folderId: row.folder_id,
    listId: row.list_id,
    level: row.level,
    itemScope: row.item_scope,
  }));
}

export interface ListInfo {
  id: string;
  spaceId: string;
  folderId: string | null;
  name: string;
  isSensitive: boolean;
}

/** The list (if the person can see it at all) and their effective access to it. */
export async function accessToList(
  tx: Tx,
  actor: Actor,
  listId: string,
): Promise<{ list: ListInfo; access: ResolvedAccess } | undefined> {
  const row = await one<{
    id: string;
    space_id: string;
    folder_id: string | null;
    name: string;
    is_sensitive: boolean;
  }>(
    tx,
    sql`SELECT id, space_id, folder_id, name, is_sensitive FROM app.lists WHERE id = ${listId}`,
  );
  if (!row) return undefined;
  const list: ListInfo = {
    id: row.id,
    spaceId: row.space_id,
    folderId: row.folder_id,
    name: row.name,
    isSensitive: row.is_sensitive,
  };
  const grants = await loadOwnGrants(tx, actor);
  const access = resolveListAccess(actor.role, grants, {
    listId: list.id,
    folderId: list.folderId,
    spaceId: list.spaceId,
  });
  return { list, access };
}

/** Effective access to any scope, or undefined when the person cannot see it. */
export async function accessToScope(
  tx: Tx,
  actor: Actor,
  scopeType: ScopeType,
  scopeId: string,
): Promise<ResolvedAccess | undefined> {
  if (scopeType === 'list') return (await accessToList(tx, actor, scopeId))?.access;

  const grants = await loadOwnGrants(tx, actor);
  if (scopeType === 'folder') {
    const folder = await one<{ id: string; space_id: string }>(
      tx,
      sql`SELECT id, space_id FROM app.folders WHERE id = ${scopeId}`,
    );
    return folder
      ? resolveFolderAccess(actor.role, grants, { folderId: folder.id, spaceId: folder.space_id })
      : undefined;
  }
  const space = await one<{ id: string }>(tx, sql`SELECT id FROM app.spaces WHERE id = ${scopeId}`);
  return space ? resolveSpaceAccess(actor.role, grants, space.id) : undefined;
}
