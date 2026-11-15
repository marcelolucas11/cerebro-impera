import { hasCapability, type Capability, type Role } from '@cerebro/shared';
import type { FastifyRequest } from 'fastify';
import { digest } from './crypto/tokens.js';
import { inTransaction, one, sql, type Tx } from './db.js';
import type { Deps } from './deps.js';
import { readToken, SESSION_COOKIE } from './http/cookies.js';
import { forbidden, stepUpRequired, unauthorized } from './http/errors.js';

/** The signed-in person behind a request, as verified by the database. */
export interface Actor {
  userId: string;
  sessionId: string;
  deviceId: string;
  role: Role;
  name: string;
  email: string;
  /** True when the second factor was confirmed recently. */
  stepUp: boolean;
  capabilities: string[];
}

interface ContextRow {
  ctx_user_id: string;
  ctx_session_id: string;
  ctx_device_id: string;
  ctx_role: Role;
  ctx_name: string;
  ctx_email: string;
  ctx_step_up: boolean;
  ctx_capabilities: string[];
}

/**
 * Runs `fn` in one database transaction bound to the person who owns the
 * session cookie. The binding happens inside the database
 * (`authz.begin_request`), which checks the session, the account and the
 * device; from then on row-level security answers for that person only.
 */
export async function withActor<T>(
  deps: Deps,
  request: FastifyRequest,
  fn: (tx: Tx, actor: Actor) => Promise<T>,
): Promise<T> {
  const token = readToken(request, SESSION_COOKIE);
  if (token === undefined) throw unauthorized();

  return inTransaction(deps.pools.app, async (tx) => {
    const row = await one<ContextRow>(
      tx,
      sql`SELECT * FROM authz.begin_request(${digest(token)}, ${request.ip}::inet)`,
    );
    if (!row) throw unauthorized();
    return fn(tx, {
      userId: row.ctx_user_id,
      sessionId: row.ctx_session_id,
      deviceId: row.ctx_device_id,
      role: row.ctx_role,
      name: row.ctx_name,
      email: row.ctx_email,
      stepUp: row.ctx_step_up,
      capabilities: row.ctx_capabilities,
    });
  });
}

export function requireCapability(actor: Actor, capability: Capability): void {
  if (!hasCapability(actor, capability)) throw forbidden();
}

export function requireOwner(actor: Actor): void {
  if (actor.role !== 'owner') throw forbidden();
}

/** Critical actions need the second factor to have been confirmed recently. */
export function requireStepUp(actor: Actor): void {
  if (!actor.stepUp) throw stepUpRequired();
}
