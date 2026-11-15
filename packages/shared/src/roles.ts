/** Roles, lowest to highest. The order matters: it is the chain of command. */
export const ROLES = ['employee', 'manager', 'admin', 'owner'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['invited', 'active', 'suspended'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const RANK: Record<Role, number> = { employee: 0, manager: 1, admin: 2, owner: 3 };

/** True when `a` is strictly above `b` in the chain of command. */
export function outranks(a: Role, b: Role): boolean {
  return RANK[a] > RANK[b];
}

/**
 * Who may administer whom. Owners manage everyone; anyone else needs the
 * `users.manage` capability and may only touch people strictly below them.
 * Nobody but an owner can administer their own account's role or status.
 */
export function canManageUser(
  actor: { id: string; role: Role; canManageUsers: boolean },
  target: { id: string; role: Role },
): boolean {
  if (actor.role === 'owner') return true;
  if (actor.id === target.id) return false;
  return actor.canManageUsers && outranks(actor.role, target.role);
}

/** Roles an actor is allowed to assign to someone else. */
export function assignableRoles(actor: { role: Role; canManageUsers: boolean }): Role[] {
  if (actor.role === 'owner') return [...ROLES];
  if (!actor.canManageUsers) return [];
  return ROLES.filter((r) => outranks(actor.role, r));
}
