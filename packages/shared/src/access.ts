import type { Role } from './roles.js';

/** Access levels, lowest to highest. Each level includes the ones before it. */
export const ACCESS_LEVELS = ['none', 'view', 'comment', 'edit', 'manage'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

/**
 * Which items a person sees inside a list they can open:
 * - `assigned`: only items assigned to them or created by them;
 * - `all`: every item in the list.
 */
export const ITEM_SCOPES = ['assigned', 'all'] as const;
export type ItemScope = (typeof ITEM_SCOPES)[number];

export const SCOPE_TYPES = ['space', 'folder', 'list'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export interface AccessGrant {
  spaceId: string | null;
  folderId: string | null;
  listId: string | null;
  level: AccessLevel;
  itemScope: ItemScope;
}

export interface ResolvedAccess {
  level: AccessLevel;
  itemScope: ItemScope;
}

export interface ListLocation {
  listId: string;
  folderId: string | null;
  spaceId: string;
}

const NO_ACCESS: ResolvedAccess = { level: 'none', itemScope: 'assigned' };
const FULL_ACCESS: ResolvedAccess = { level: 'manage', itemScope: 'all' };

export function levelAtLeast(level: AccessLevel, minimum: AccessLevel): boolean {
  return ACCESS_LEVELS.indexOf(level) >= ACCESS_LEVELS.indexOf(minimum);
}

/** Employees see only their own items unless an owner explicitly widens it. */
export function defaultItemScope(role: Role): ItemScope {
  return role === 'employee' ? 'assigned' : 'all';
}

function pick(grant: AccessGrant): ResolvedAccess {
  return { level: grant.level, itemScope: grant.itemScope };
}

/**
 * Effective access to a list. The most specific grant wins: list, then folder,
 * then space. An explicit `none` on a list therefore hides it even when the
 * space is granted. This mirrors `authz.scope_access` in the database; the two
 * are kept as independent implementations on purpose (defense in depth).
 */
export function resolveListAccess(
  role: Role,
  grants: readonly AccessGrant[],
  location: ListLocation,
): ResolvedAccess {
  if (role === 'owner') return FULL_ACCESS;
  const onList = grants.find((g) => g.listId === location.listId);
  if (onList) return pick(onList);
  if (location.folderId !== null) {
    const onFolder = grants.find((g) => g.folderId === location.folderId);
    if (onFolder) return pick(onFolder);
  }
  const onSpace = grants.find((g) => g.spaceId === location.spaceId);
  return onSpace ? pick(onSpace) : NO_ACCESS;
}

export function resolveFolderAccess(
  role: Role,
  grants: readonly AccessGrant[],
  location: { folderId: string; spaceId: string },
): ResolvedAccess {
  if (role === 'owner') return FULL_ACCESS;
  const onFolder = grants.find((g) => g.folderId === location.folderId);
  if (onFolder) return pick(onFolder);
  const onSpace = grants.find((g) => g.spaceId === location.spaceId);
  return onSpace ? pick(onSpace) : NO_ACCESS;
}

export function resolveSpaceAccess(
  role: Role,
  grants: readonly AccessGrant[],
  spaceId: string,
): ResolvedAccess {
  if (role === 'owner') return FULL_ACCESS;
  const onSpace = grants.find((g) => g.spaceId === spaceId);
  return onSpace ? pick(onSpace) : NO_ACCESS;
}

/**
 * "Nobody grants what they do not have": a non-owner may only hand out access
 * on a scope they fully manage, and may only widen item visibility to `all`
 * when they themselves see all items there.
 */
export function mayGrant(
  role: Role,
  own: ResolvedAccess,
  requested: { itemScope: ItemScope },
): boolean {
  if (role === 'owner') return true;
  if (own.level !== 'manage') return false;
  return requested.itemScope === 'assigned' || own.itemScope === 'all';
}
