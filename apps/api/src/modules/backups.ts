import { readFile } from 'node:fs/promises';
import { requireCapability, type Actor } from '../actor.js';
import { one, sql, type Tx } from '../db.js';
import type { Deps } from '../deps.js';

/*
 * How the copies are doing, as the backup service writes it: shown to whoever
 * sees the audit trail, and turned into alerts for the owners by the hourly
 * routine. The API only reads the service's file; it has no way to change the
 * copies or reach where they are kept.
 */

export interface BackupState {
  lastBackup: {
    startedAt: string;
    finishedAt: string;
    ok: boolean;
    snapshot: string | null;
    bytes: number | null;
    problem: string | null;
  } | null;
  lastSuccessAt: string | null;
  lastRestoreTest: {
    at: string;
    ok: boolean;
    people: number | null;
    problem: string | null;
  } | null;
  nextRunAt: string | null;
}

export interface BackupView extends BackupState {
  /** False when this installation has no backup service. */
  configured: boolean;
  /** False when it has one but its situation cannot be read now. */
  readable: boolean;
}

/** Over a day and two hours without a good copy is late: one run missed, at least. */
export const STALE_MS = 26 * 60 * 60 * 1000;

const EMPTY: BackupState = {
  lastBackup: null,
  lastSuccessAt: null,
  lastRestoreTest: null,
  nextRunAt: null,
};

async function readState(file: string): Promise<BackupState | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<BackupState>;
    return {
      lastBackup: parsed.lastBackup ?? null,
      lastSuccessAt: parsed.lastSuccessAt ?? null,
      lastRestoreTest: parsed.lastRestoreTest ?? null,
      nextRunAt: parsed.nextRunAt ?? null,
    };
  } catch {
    return null;
  }
}

export async function backups(deps: Deps, actor: Actor): Promise<BackupView> {
  requireCapability(actor, 'audit.view');
  if (deps.config.backupStatusFile === null)
    return { ...EMPTY, configured: false, readable: false };
  const state = await readState(deps.config.backupStatusFile);
  return { ...(state ?? EMPTY), configured: true, readable: state !== null };
}

/** What is wrong with the copies now, as alert kinds (empty when all is well). */
export function problems(state: BackupState | null, now: number): string[] {
  if (state === null) return ['backup_stale'];
  const found: string[] = [];
  if (state.lastBackup !== null && !state.lastBackup.ok) found.push('backup_failed');
  if (
    state.lastBackup !== null &&
    (state.lastSuccessAt === null || now - Date.parse(state.lastSuccessAt) > STALE_MS)
  ) {
    found.push('backup_stale');
  }
  if (state.lastRestoreTest !== null && !state.lastRestoreTest.ok)
    found.push('restore_test_failed');
  return found;
}

/** Run by the hourly routine: warns the owners, once a day per kind. Returns how many were raised. */
export async function checkBackups(db: Tx, deps: Deps): Promise<number> {
  if (deps.config.backupStatusFile === null) return 0;
  const state = await readState(deps.config.backupStatusFile);
  let raised = 0;
  for (const kind of problems(state, deps.now())) {
    const detail = {
      problem:
        kind === 'restore_test_failed'
          ? (state?.lastRestoreTest?.problem ?? null)
          : (state?.lastBackup?.problem ?? null),
      lastSuccessAt: state?.lastSuccessAt ?? null,
    };
    const made = await one<{ raised: boolean }>(
      db,
      sql`SELECT app.raise_backup_alert(${kind}, ${JSON.stringify(detail)}::jsonb) AS raised`,
    );
    if (made?.raised === true) raised += 1;
  }
  return raised;
}
