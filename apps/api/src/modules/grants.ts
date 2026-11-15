import { randomUUID } from 'node:crypto';
import {
  canManageUser,
  defaultItemScope,
  hasCapability,
  mayGrant,
  type AccessLevel,
  type ItemScope,
  type ScopeType,
} from '@cerebro/shared';
import { requireStepUp, type Actor } from '../actor.js';
import { one, rows, run, sql, type Sql, type Tx } from '../db.js';
import { forbidden, notFound } from '../http/errors.js';
import { accessToScope } from './access.js';
import { getUser } from './people.js';

export interface GrantView {
  id: string;
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  level: AccessLevel;
  itemScope: ItemScope;
  grantedBy: string;
  updatedAt: Date;
}

interface GrantRow {
  id: string;
  user_id: string;
  space_id: string | null;
  folder_id: string | null;
  list_id: string | null;
  level: AccessLevel;
  item_scope: ItemScope;
  granted_by: string;
  updated_at: Date;
}

function toView(row: GrantRow): GrantView {
  const [scopeType, scopeId]: [ScopeType, string | null] =
    row.list_id !== null
      ? ['list', row.list_id]
      : row.folder_id !== null
        ? ['folder', row.folder_id]
        : ['space', row.space_id];
  if (scopeId === null) throw new Error('grant without a scope');
  return {
    id: row.id,
    userId: row.user_id,
    scopeType,
    scopeId,
    level: row.level,
    itemScope: row.item_scope,
    grantedBy: row.granted_by,
    updatedAt: row.updated_at,
  };
}

const COLUMNS =
  'id, user_id, space_id, folder_id, list_id, level, item_scope, granted_by, updated_at';

/** A person's grants: their own, or those of someone the caller administers. */
export async function listGrants(tx: Tx, actor: Actor, userId: string): Promise<GrantView[]> {
  if (userId !== actor.userId) {
    const target = await getUser(tx, userId);
    if (!target) throw notFound();
    const manages = canManageUser(
      { id: actor.userId, role: actor.role, canManageUsers: hasCapability(actor, 'users.manage') },
      target,
    );
    if (!manages) throw forbidden();
  }
  // The database narrows this further to scopes the caller fully manages.
  const found = await rows<GrantRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.access_grants WHERE user_id = $1 ORDER BY created_at`,
    values: [userId],
  });
  return found.map(toView);
}

function whereScope(userId: string, scopeType: ScopeType, scopeId: string): Sql {
  // The column name comes from a closed set of three literals, never from input.
  const column = { space: 'space_id', folder: 'folder_id', list: 'list_id' }[scopeType];
  return {
    text: `SELECT ${COLUMNS} FROM app.access_grants WHERE user_id = $1 AND ${column} = $2`,
    values: [userId, scopeId],
  };
}

export async function upsertGrant(
  tx: Tx,
  actor: Actor,
  body: {
    userId: string;
    scopeType: ScopeType;
    scopeId: string;
    level: AccessLevel;
    itemScope?: ItemScope | undefined;
  },
): Promise<GrantView> {
  requireStepUp(actor);
  const target = await getUser(tx, body.userId);
  if (!target) throw notFound();
  const own = await accessToScope(tx, actor, body.scopeType, body.scopeId);
  if (!own) throw notFound();

  const itemScope = body.itemScope ?? defaultItemScope(target.role);
  if (actor.role !== 'owner') {
    const manages = canManageUser(
      { id: actor.userId, role: actor.role, canManageUsers: hasCapability(actor, 'users.manage') },
      target,
    );
    if (!manages || !mayGrant(actor.role, own, { itemScope })) throw forbidden();
  }

  const existing = await one<GrantRow>(tx, whereScope(body.userId, body.scopeType, body.scopeId));
  if (existing) {
    await run(
      tx,
      sql`UPDATE app.access_grants
          SET level = ${body.level}::app.access_level, item_scope = ${itemScope}::app.item_scope
          WHERE id = ${existing.id}`,
    );
  } else {
    await run(
      tx,
      sql`INSERT INTO app.access_grants (id, user_id, space_id, folder_id, list_id, level, item_scope)
          VALUES (${randomUUID()}, ${body.userId},
                  ${body.scopeType === 'space' ? body.scopeId : null},
                  ${body.scopeType === 'folder' ? body.scopeId : null},
                  ${body.scopeType === 'list' ? body.scopeId : null},
                  ${body.level}::app.access_level, ${itemScope}::app.item_scope)`,
    );
  }
  const saved = await one<GrantRow>(tx, whereScope(body.userId, body.scopeType, body.scopeId));
  if (!saved) throw forbidden();
  return toView(saved);
}

export async function deleteGrant(tx: Tx, actor: Actor, grantId: string): Promise<void> {
  requireStepUp(actor);
  const removed = await run(tx, sql`DELETE FROM app.access_grants WHERE id = ${grantId}`);
  // Zero rows covers "does not exist", "not visible" and "not yours to remove".
  if (removed !== 1) throw notFound();
}
