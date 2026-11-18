import { randomUUID } from 'node:crypto';
import { MAX_STAGES_PER_LIST, type StageDraft, type StageKind } from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { openItem, openList } from './structure.js';

/*
 * Stages are what a list is read by: its groups in the list view and its
 * columns on the board. Anyone who can open the list sees them; only whoever
 * manages the list changes them.
 */

export interface StageView {
  id: string;
  listId: string;
  name: string;
  color: string;
  kind: StageKind;
  position: number;
}

interface StageRow {
  id: string;
  list_id: string;
  name: string;
  color: string;
  kind: StageKind;
  position: number;
}

const toStage = (row: StageRow): StageView => ({
  id: row.id,
  listId: row.list_id,
  name: row.name,
  color: row.color,
  kind: row.kind,
  position: row.position,
});

async function stagesOf(tx: Tx, listId: string): Promise<StageView[]> {
  const found = await rows<StageRow>(
    tx,
    sql`SELECT id, list_id, name, color, kind, position FROM app.list_stages
        WHERE list_id = ${listId} ORDER BY position, created_at`,
  );
  return found.map(toStage);
}

export async function listStages(tx: Tx, actor: Actor, listId: string): Promise<StageView[]> {
  // The names of the stages are not the sensitive part of a sensitive list,
  // but opening one still follows the same rule as its items.
  await openList(tx, actor, listId, 'view');
  return stagesOf(tx, listId);
}

export async function createStage(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: { name: string; color?: string | undefined; kind?: StageKind | undefined },
): Promise<StageView> {
  await openList(tx, actor, listId, 'manage');
  const existing = await stagesOf(tx, listId);
  if (existing.length >= MAX_STAGES_PER_LIST) throw conflict('too_many_stages');
  const id = randomUUID();
  const position = Math.max(-1, ...existing.map((stage) => stage.position)) + 1;
  await run(
    tx,
    sql`INSERT INTO app.list_stages (id, list_id, name, color, kind, position)
        VALUES (${id}, ${listId}, ${body.name}, ${body.color ?? '#9ba6b8'},
                ${body.kind ?? 'active'}, ${position})`,
  );
  const created = (await stagesOf(tx, listId)).find((stage) => stage.id === id);
  if (!created) throw notFound();
  return created;
}

/** The stage, when the caller may manage the list it belongs to. */
async function openStage(tx: Tx, actor: Actor, stageId: string): Promise<StageView> {
  const row = await one<StageRow>(
    tx,
    sql`SELECT id, list_id, name, color, kind, position FROM app.list_stages WHERE id = ${stageId}`,
  );
  if (!row) throw notFound();
  await openList(tx, actor, row.list_id, 'manage');
  return toStage(row);
}

export async function updateStage(
  tx: Tx,
  actor: Actor,
  stageId: string,
  body: { name?: string | undefined; color?: string | undefined; kind?: StageKind | undefined },
): Promise<StageView> {
  const stage = await openStage(tx, actor, stageId);
  await run(
    tx,
    sql`UPDATE app.list_stages SET
          name = coalesce(${body.name ?? null}, name),
          color = coalesce(${body.color ?? null}, color),
          kind = coalesce(${body.kind ?? null}::app.stage_kind, kind)
        WHERE id = ${stageId}`,
  );
  const updated = (await stagesOf(tx, stage.listId)).find((candidate) => candidate.id === stageId);
  if (!updated) throw notFound();
  return updated;
}

/**
 * Brings a set of stages into a list, from a preset, another list or a file.
 * Stages the list lacks are created; one with the same name (whatever the
 * capitalisation) takes the set's color and meaning. Nothing is removed: the
 * set comes first, in its order, and the list's other stages follow.
 */
export async function applyStages(
  tx: Tx,
  actor: Actor,
  listId: string,
  drafts: readonly StageDraft[],
): Promise<StageView[]> {
  await openList(tx, actor, listId, 'manage');
  const current = await stagesOf(tx, listId);
  const byName = new Map(current.map((stage) => [stage.name.toLowerCase(), stage]));
  const missing = drafts.filter((draft) => !byName.has(draft.name.toLowerCase()));
  if (current.length + missing.length > MAX_STAGES_PER_LIST) throw conflict('too_many_stages');

  const order: string[] = [];
  for (const draft of drafts) {
    const existing = byName.get(draft.name.toLowerCase());
    if (existing) {
      await run(
        tx,
        sql`UPDATE app.list_stages SET color = ${draft.color}, kind = ${draft.kind}
            WHERE id = ${existing.id}`,
      );
      order.push(existing.id);
    } else {
      const id = randomUUID();
      await run(
        tx,
        sql`INSERT INTO app.list_stages (id, list_id, name, color, kind, position)
            VALUES (${id}, ${listId}, ${draft.name}, ${draft.color}, ${draft.kind},
                    ${current.length + order.length})`,
      );
      order.push(id);
    }
  }
  const placed = new Set(order);
  order.push(...current.filter((stage) => !placed.has(stage.id)).map((stage) => stage.id));
  for (const [position, id] of order.entries()) {
    await run(tx, sql`UPDATE app.list_stages SET position = ${position} WHERE id = ${id}`);
  }
  return stagesOf(tx, listId);
}

/** Sets the order of all stages of a list at once: the ids must be exactly the list's stages. */
export async function reorderStages(
  tx: Tx,
  actor: Actor,
  listId: string,
  ids: readonly string[],
): Promise<StageView[]> {
  await openList(tx, actor, listId, 'manage');
  const current = await stagesOf(tx, listId);
  const wanted = new Set(ids);
  if (wanted.size !== ids.length || wanted.size !== current.length) {
    throw badRequest('invalid_order');
  }
  if (!current.every((stage) => wanted.has(stage.id))) throw badRequest('invalid_order');
  for (const [position, id] of ids.entries()) {
    await run(tx, sql`UPDATE app.list_stages SET position = ${position} WHERE id = ${id}`);
  }
  return stagesOf(tx, listId);
}

/**
 * Removes a stage. Items still in it must be given another stage of the same
 * list; if any item remains there (including items the caller cannot see),
 * nothing is removed.
 */
export async function deleteStage(
  tx: Tx,
  actor: Actor,
  stageId: string,
  body: { moveTo?: string | undefined },
): Promise<{ ok: true; moved: number }> {
  const stage = await openStage(tx, actor, stageId);
  let moved = 0;
  if (body.moveTo !== undefined) {
    if (body.moveTo === stageId) throw badRequest('invalid_stage');
    const target = await one(
      tx,
      sql`SELECT 1 FROM app.list_stages WHERE id = ${body.moveTo} AND list_id = ${stage.listId}`,
    );
    if (!target) throw badRequest('invalid_stage');
    moved = await run(
      tx,
      sql`UPDATE app.items SET stage_id = ${body.moveTo}
          WHERE list_id = ${stage.listId} AND stage_id = ${stageId}`,
    );
  }
  // Counted with the database's own view of the table: an item the caller
  // cannot see still keeps its stage from disappearing under it.
  const inUse = await one<{ in_use: boolean }>(
    tx,
    sql`SELECT app.stage_in_use(${stageId}) AS in_use`,
  );
  if (inUse?.in_use) throw conflict('stage_in_use');
  const removed = await run(tx, sql`DELETE FROM app.list_stages WHERE id = ${stageId}`);
  if (removed !== 1) throw notFound();
  return { ok: true, moved };
}

export interface StageStayView {
  stageId: string;
  stageName: string;
  enteredAt: Date;
  /** Null while the item is still in this stage. */
  leftAt: Date | null;
  movedBy: string | null;
}

/** Every stage the item has been in, oldest first, with when it entered and left. */
export async function itemStageHistory(
  tx: Tx,
  actor: Actor,
  itemId: string,
): Promise<StageStayView[]> {
  await openItem(tx, actor, itemId, 'view');
  const found = await rows<{
    stage_id: string;
    stage_name: string;
    entered_at: Date;
    left_at: Date | null;
    moved_by: string | null;
  }>(
    tx,
    sql`SELECT stage_id, stage_name, entered_at, left_at, moved_by
        FROM app.item_stage_history WHERE item_id = ${itemId} ORDER BY entered_at, id`,
  );
  return found.map((row) => ({
    stageId: row.stage_id,
    stageName: row.stage_name,
    enteredAt: row.entered_at,
    leftAt: row.left_at,
    movedBy: row.moved_by,
  }));
}
