import { randomUUID } from 'node:crypto';
import {
  assignableRoles,
  canManageUser,
  hasCapability,
  type Capability,
  type Role,
  type UserStatus,
} from '@cerebro/shared';
import { requireCapability, requireOwner, requireStepUp, type Actor } from '../actor.js';
import { digest, newToken } from '../crypto/tokens.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { conflict, forbidden, notFound } from '../http/errors.js';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  capabilities: string[];
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  created_at: Date;
  capabilities: string[];
}

function toView(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    capabilities: row.capabilities,
  };
}

const USER_COLUMNS = `u.id, u.email, u.name, u.role, u.status, u.created_at,
  coalesce((SELECT array_agg(c.capability ORDER BY c.capability)
            FROM app.user_capabilities c WHERE c.user_id = u.id), '{}'::text[]) AS capabilities`;

function managerOf(actor: Actor): { id: string; role: Role; canManageUsers: boolean } {
  return {
    id: actor.userId,
    role: actor.role,
    canManageUsers: hasCapability(actor, 'users.manage'),
  };
}

/** Returns the person only if the caller is allowed to see them. */
export async function getUser(tx: Tx, id: string): Promise<UserView | undefined> {
  const row = await one<UserRow>(tx, {
    text: `SELECT ${USER_COLUMNS} FROM app.users u WHERE u.id = $1`,
    values: [id],
  });
  return row ? toView(row) : undefined;
}

export async function listUsers(tx: Tx, actor: Actor): Promise<UserView[]> {
  requireCapability(actor, 'users.manage');
  const found = await rows<UserRow>(tx, {
    text: `SELECT ${USER_COLUMNS} FROM app.users u ORDER BY u.name, u.email`,
    values: [],
  });
  return found.map(toView);
}

export interface InviteView {
  /** Shown once to whoever created it; only a digest is stored. */
  token: string;
  kind: 'invite' | 'reset';
  expiresAt: Date;
}

async function issueInvite(tx: Tx, userId: string, kind: 'invite' | 'reset'): Promise<InviteView> {
  const token = newToken();
  const row = await one<{ expires_at: Date }>(
    tx,
    sql`SELECT auth.create_invite(${userId}, ${digest(token)}, ${kind}) AS expires_at`,
  );
  if (!row) throw new Error('invite was not created');
  return { token, kind, expiresAt: row.expires_at };
}

export async function createUser(
  tx: Tx,
  actor: Actor,
  body: { email: string; name: string; role: Role },
): Promise<{ user: UserView; invite: InviteView }> {
  requireCapability(actor, 'users.manage');
  requireStepUp(actor);
  if (!assignableRoles(managerOf(actor)).includes(body.role)) throw forbidden();

  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.users (id, email, name, role)
        VALUES (${id}, ${body.email}, ${body.name}, ${body.role}::app.user_role)`,
  );
  const invite = await issueInvite(tx, id, 'invite');
  const user = await getUser(tx, id);
  if (!user) throw new Error('created user is not visible to its creator');
  return { user, invite };
}

export async function updateUser(
  tx: Tx,
  actor: Actor,
  id: string,
  body: {
    name?: string | undefined;
    role?: Role | undefined;
    status?: 'active' | 'suspended' | undefined;
  },
): Promise<UserView> {
  const target = await getUser(tx, id);
  if (!target) throw notFound();

  const manages = canManageUser(managerOf(actor), target);
  const changesAccess = body.role !== undefined || body.status !== undefined;
  if (changesAccess) {
    if (!manages) throw forbidden();
    requireStepUp(actor);
    if (body.role !== undefined && !assignableRoles(managerOf(actor)).includes(body.role)) {
      throw forbidden();
    }
  } else if (target.id !== actor.userId && !manages) {
    throw forbidden();
  }

  await run(
    tx,
    sql`UPDATE app.users SET
          name = coalesce(${body.name ?? null}, name),
          role = coalesce(${body.role ?? null}::app.user_role, role),
          status = coalesce(${body.status ?? null}::app.user_status, status)
        WHERE id = ${id}`,
  );
  const updated = await getUser(tx, id);
  if (!updated) throw notFound();
  return updated;
}

/** Only owners hand out capabilities, and only with a fresh second factor. */
export async function setCapabilities(
  tx: Tx,
  actor: Actor,
  id: string,
  capabilities: readonly Capability[],
): Promise<UserView> {
  requireOwner(actor);
  requireStepUp(actor);
  const target = await getUser(tx, id);
  if (!target) throw notFound();
  if (target.role === 'owner') throw conflict('owners_hold_every_capability');

  const wanted = new Set<string>(capabilities);
  for (const current of target.capabilities) {
    if (!wanted.has(current)) {
      await run(
        tx,
        sql`DELETE FROM app.user_capabilities WHERE user_id = ${id} AND capability = ${current}`,
      );
    }
  }
  for (const capability of wanted) {
    if (!target.capabilities.includes(capability)) {
      await run(
        tx,
        sql`INSERT INTO app.user_capabilities (user_id, capability) VALUES (${id}, ${capability})`,
      );
    }
  }
  const updated = await getUser(tx, id);
  if (!updated) throw notFound();
  return updated;
}

/** New invite for someone who has not joined yet, or an access reset for someone who has. */
export async function reissueInvite(tx: Tx, actor: Actor, id: string): Promise<InviteView> {
  const target = await getUser(tx, id);
  if (!target) throw notFound();
  if (!canManageUser(managerOf(actor), target)) throw forbidden();
  requireStepUp(actor);
  if (target.status === 'suspended') throw conflict('account_suspended');
  return issueInvite(tx, id, target.status === 'invited' ? 'invite' : 'reset');
}

export async function revokeUserSessions(tx: Tx, actor: Actor, id: string): Promise<number> {
  const target = await getUser(tx, id);
  if (!target) throw notFound();
  if (target.id !== actor.userId && !canManageUser(managerOf(actor), target)) throw forbidden();
  const row = await one<{ count: number }>(
    tx,
    sql`SELECT auth.revoke_user_sessions(${id}) AS count`,
  );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Sessions and devices
// ---------------------------------------------------------------------------

export interface SessionView {
  id: string;
  deviceId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string;
  current: boolean;
}

export async function mySessions(tx: Tx): Promise<SessionView[]> {
  const found = await rows<{
    id: string;
    device_id: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
    ip: string | null;
    user_agent: string;
    is_current: boolean;
  }>(tx, sql`SELECT * FROM auth.my_sessions()`);
  return found.map((row) => ({
    id: row.id,
    deviceId: row.device_id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ip: row.ip,
    userAgent: row.user_agent,
    current: row.is_current,
  }));
}

export async function revokeSession(tx: Tx, sessionId: string): Promise<void> {
  const row = await one<{ revoked: boolean }>(
    tx,
    sql`SELECT auth.revoke_session(${sessionId}) AS revoked`,
  );
  if (row?.revoked !== true) throw notFound();
}

export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked';

export interface DeviceView {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: Role;
  status: DeviceStatus;
  userAgent: string;
  createdAt: Date;
  createdIp: string | null;
  lastSeenAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
}

export async function listDevices(tx: Tx, onlyMine: boolean): Promise<DeviceView[]> {
  const found = await rows<{
    id: string;
    user_id: string;
    user_name: string;
    user_email: string;
    user_role: Role;
    status: DeviceStatus;
    user_agent: string;
    created_at: Date;
    created_ip: string | null;
    last_seen_at: Date | null;
    decided_by: string | null;
    decided_at: Date | null;
  }>(tx, sql`SELECT * FROM auth.list_devices(${onlyMine})`);
  return found.map((row) => ({
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    userEmail: row.user_email,
    userRole: row.user_role,
    status: row.status,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    createdIp: row.created_ip,
    lastSeenAt: row.last_seen_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  }));
}

export async function decideDevice(
  tx: Tx,
  actor: Actor,
  deviceId: string,
  decision: 'approve' | 'reject' | 'revoke',
): Promise<DeviceStatus> {
  // The listing already hides devices the caller has no business seeing.
  const device = (await listDevices(tx, false)).find((candidate) => candidate.id === deviceId);
  if (!device) throw notFound();

  const hasAuthority =
    actor.role === 'owner' ||
    (hasCapability(actor, 'devices.approve') &&
      canManageUser(
        { ...managerOf(actor), canManageUsers: true },
        { id: device.userId, role: device.userRole },
      ));
  const revokingOwn = decision === 'revoke' && device.userId === actor.userId;
  if (!hasAuthority && !revokingOwn) throw forbidden();
  if (decision === 'approve') requireStepUp(actor);

  const row = await one<{ status: DeviceStatus }>(
    tx,
    sql`SELECT auth.decide_device(${deviceId}, ${decision}) AS status`,
  );
  if (!row) throw new Error('device decision returned nothing');
  return row.status;
}
