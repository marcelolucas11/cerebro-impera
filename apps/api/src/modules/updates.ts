import { requireOwner, requireStepUp, type Actor } from '../actor.js';
import { one, run, sql, type Tx } from '../db.js';
import type { Deps } from '../deps.js';
import { serviceUnavailable } from '../http/errors.js';
import { UpdaterUnreachable, type Updater } from '../updates/client.js';
import { UpdaterRefusal, type UpdaterStatus } from '@cerebro/shared/protocol';

/*
 * Updates, as the owners see them: the version in use, a newer one when the
 * updater found one, and how an update in progress is going. Only owners; to
 * apply one, with the code confirmed again. The updater does the work on the
 * other side of an internal network; everything asked of it, and every
 * outcome, goes on the record.
 */

export interface UpdatesView {
  /** False when this installation has no updater. */
  configured: boolean;
  /** False when it has one but it cannot be reached now. */
  reachable: boolean;
  current: string;
  checkedAt: string | null;
  available: UpdaterStatus['available'];
  job: UpdaterStatus['job'];
  /** Why the updater just refused to apply a version (no such version, signature, busy). */
  refused: string | null;
}

const record = (tx: Tx, action: string, target: string | null, metadata: object): Promise<number> =>
  run(
    tx,
    sql`SELECT audit.record(${action}, 'update', ${target}, ${JSON.stringify(metadata)}::jsonb)`,
  );

/** An update that ended and is not on the record yet goes there, once. */
async function recordOutcome(tx: Tx, job: UpdaterStatus['job']): Promise<void> {
  if (job === null || job.state === 'running') return;
  const action =
    job.state === 'applied'
      ? 'update.applied'
      : job.state === 'rolled_back'
        ? 'update.rolled_back'
        : 'update.failed';
  const seen = await one<{ found: boolean }>(
    tx,
    sql`SELECT EXISTS (SELECT 1 FROM audit.log WHERE action = ${action} AND target_id = ${job.id})
          AS found`,
  );
  if (seen?.found !== true) {
    await record(tx, action, job.id, { from: job.from, to: job.to, problem: job.problem });
  }
}

function view(deps: Deps, status: UpdaterStatus | null): UpdatesView {
  return {
    configured: deps.updater !== null,
    reachable: status !== null,
    current: status?.current ?? deps.config.version,
    checkedAt: status?.checkedAt ?? null,
    available: status?.available ?? null,
    job: status?.job ?? null,
    refused: null,
  };
}

async function ask(
  updater: Updater,
  question: (updater: Updater) => Promise<UpdaterStatus>,
): Promise<UpdaterStatus | null> {
  try {
    return await question(updater);
  } catch (error) {
    if (error instanceof UpdaterUnreachable) return null;
    throw error;
  }
}

export async function updates(tx: Tx, deps: Deps, actor: Actor): Promise<UpdatesView> {
  requireOwner(actor);
  if (deps.updater === null) return view(deps, null);
  const status = await ask(deps.updater, (updater) => updater.status());
  if (status !== null) await recordOutcome(tx, status.job);
  return view(deps, status);
}

export async function checkUpdates(tx: Tx, deps: Deps, actor: Actor): Promise<UpdatesView> {
  requireOwner(actor);
  if (deps.updater === null) throw serviceUnavailable('updater_missing');
  const status = await ask(deps.updater, (updater) => updater.check());
  if (status === null) throw serviceUnavailable('updater_unreachable');
  await record(tx, 'update.checked', null, { found: status.available?.version ?? null });
  return view(deps, status);
}

export async function applyUpdate(
  tx: Tx,
  deps: Deps,
  actor: Actor,
  version: string,
): Promise<UpdatesView> {
  requireOwner(actor);
  requireStepUp(actor);
  if (deps.updater === null) throw serviceUnavailable('updater_missing');
  const updater = deps.updater;
  let status: UpdaterStatus | null;
  try {
    status = await ask(updater, (one) => one.apply(version));
  } catch (error) {
    if (!(error instanceof UpdaterRefusal)) throw error;
    // Refused (no such version, signature does not hold, one already running): on the record,
    // and answered as such, so the record is kept.
    await record(tx, 'update.refused', null, { to: version, reason: error.code });
    return { ...view(deps, await ask(updater, (one) => one.status())), refused: error.code };
  }
  if (status === null) throw serviceUnavailable('updater_unreachable');
  await record(tx, 'update.requested', status.job?.id ?? null, {
    from: status.job?.from ?? status.current,
    to: version,
  });
  return view(deps, status);
}
