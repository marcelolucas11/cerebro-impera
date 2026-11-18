import { randomUUID } from 'node:crypto';
import { MAX_CHECKS_PER_ITEM } from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, notFound } from '../http/errors.js';
import { openItem } from './structure.js';

/*
 * The checklist inside an item. It follows the item: read by whoever sees
 * it, changed by whoever edits it. Who ticked a line, and when, is written
 * by the database.
 */

export interface CheckView {
  id: string;
  itemId: string;
  text: string;
  done: boolean;
  doneBy: string | null;
  doneAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

interface CheckRow {
  id: string;
  item_id: string;
  text: string;
  done: boolean;
  done_by: string | null;
  done_at: Date | null;
  created_by: string;
  created_at: Date;
}

const toCheck = (row: CheckRow): CheckView => ({
  id: row.id,
  itemId: row.item_id,
  text: row.text,
  done: row.done,
  doneBy: row.done_by,
  doneAt: row.done_at,
  createdBy: row.created_by,
  createdAt: row.created_at,
});

const COLUMNS = 'id, item_id, text, done, done_by, done_at, created_by, created_at';

export async function listChecks(tx: Tx, actor: Actor, itemId: string): Promise<CheckView[]> {
  await openItem(tx, actor, itemId, 'view');
  const found = await rows<CheckRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_checks WHERE item_id = $1 ORDER BY position, created_at, id`,
    values: [itemId],
  });
  return found.map(toCheck);
}

export async function addCheck(
  tx: Tx,
  actor: Actor,
  itemId: string,
  body: { text: string },
): Promise<CheckView> {
  await openItem(tx, actor, itemId, 'edit');
  const current = await one<{ count: number; last: number | null }>(
    tx,
    sql`SELECT count(*)::int AS count, max(position) AS last
        FROM app.item_checks WHERE item_id = ${itemId}`,
  );
  if ((current?.count ?? 0) >= MAX_CHECKS_PER_ITEM) throw badRequest('too_many_checks');
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.item_checks (id, item_id, text, position)
        VALUES (${id}, ${itemId}, ${body.text}, ${(current?.last ?? 0) + 1})`,
  );
  return mustFind(tx, id);
}

/** The line, and the item it is on opened for editing; not found when the caller cannot see it. */
async function openCheck(tx: Tx, actor: Actor, checkId: string): Promise<CheckRow> {
  const check = await one<CheckRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_checks WHERE id = $1`,
    values: [checkId],
  });
  if (!check) throw notFound();
  await openItem(tx, actor, check.item_id, 'edit');
  return check;
}

export async function updateCheck(
  tx: Tx,
  actor: Actor,
  checkId: string,
  body: { text?: string | undefined; done?: boolean | undefined },
): Promise<CheckView> {
  await openCheck(tx, actor, checkId);
  await run(
    tx,
    sql`UPDATE app.item_checks SET
          text = coalesce(${body.text ?? null}, text),
          done = coalesce(${body.done ?? null}::boolean, done)
        WHERE id = ${checkId}`,
  );
  return mustFind(tx, checkId);
}

export async function removeCheck(tx: Tx, actor: Actor, checkId: string): Promise<void> {
  await openCheck(tx, actor, checkId);
  await run(tx, sql`DELETE FROM app.item_checks WHERE id = ${checkId}`);
}

async function mustFind(tx: Tx, checkId: string): Promise<CheckView> {
  const row = await one<CheckRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.item_checks WHERE id = $1`,
    values: [checkId],
  });
  if (!row) throw notFound();
  return toCheck(row);
}
