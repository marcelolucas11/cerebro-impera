import { requireCapability, requireOwner, type Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { notFound } from '../http/errors.js';

export interface AuditEntry {
  seq: number;
  at: Date;
  actorUserId: string | null;
  ip: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: unknown;
}

export async function listAudit(
  tx: Tx,
  actor: Actor,
  query: {
    before?: number | undefined;
    limit: number;
    action?: string | undefined;
    actor?: string | undefined;
  },
): Promise<AuditEntry[]> {
  requireCapability(actor, 'audit.view');
  const found = await rows<{
    seq: string;
    at: Date;
    actor_user_id: string | null;
    ip: string | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata: unknown;
  }>(
    tx,
    sql`SELECT seq, at, actor_user_id, ip, action, target_type, target_id, metadata
        FROM audit.log
        WHERE (${query.before ?? null}::bigint IS NULL OR seq < ${query.before ?? null}::bigint)
          AND (${query.action ?? null}::text IS NULL OR action = ${query.action ?? null}::text)
          AND (${query.actor ?? null}::uuid IS NULL OR actor_user_id = ${query.actor ?? null}::uuid)
        ORDER BY seq DESC
        LIMIT ${query.limit}`,
  );
  return found.map((row) => ({
    seq: Number(row.seq),
    at: row.at,
    actorUserId: row.actor_user_id,
    ip: row.ip,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata,
  }));
}

/** Recomputes the hash chain; `ok: false` means the trail was tampered with. */
export async function verifyAudit(
  tx: Tx,
  actor: Actor,
): Promise<{ ok: boolean; checked: number; brokenSeq: number | null }> {
  requireCapability(actor, 'audit.view');
  const row = await one<{ ok: boolean; checked: string; broken_seq: string | null }>(
    tx,
    sql`SELECT ok, checked, broken_seq FROM audit.verify_chain()`,
  );
  if (!row) throw new Error('audit verification returned nothing');
  return {
    ok: row.ok,
    checked: Number(row.checked),
    brokenSeq: row.broken_seq === null ? null : Number(row.broken_seq),
  };
}

export interface AlertView {
  id: string;
  at: Date;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  actorUserId: string | null;
  metadata: unknown;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
}

export async function listAlerts(tx: Tx, actor: Actor): Promise<AlertView[]> {
  requireOwner(actor);
  const found = await rows<{
    id: string;
    at: Date;
    kind: string;
    severity: AlertView['severity'];
    actor_user_id: string | null;
    metadata: unknown;
    acknowledged_by: string | null;
    acknowledged_at: Date | null;
  }>(
    tx,
    sql`SELECT id, at, kind, severity, actor_user_id, metadata, acknowledged_by, acknowledged_at
        FROM app.security_alerts ORDER BY at DESC LIMIT 200`,
  );
  return found.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind,
    severity: row.severity,
    actorUserId: row.actor_user_id,
    metadata: row.metadata,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
  }));
}

export async function acknowledgeAlert(tx: Tx, actor: Actor, alertId: string): Promise<void> {
  requireOwner(actor);
  const changed = await run(
    tx,
    sql`UPDATE app.security_alerts SET acknowledged_at = now()
        WHERE id = ${alertId} AND acknowledged_at IS NULL`,
  );
  if (changed !== 1) throw notFound();
}
