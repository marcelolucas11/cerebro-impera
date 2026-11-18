import { randomUUID } from 'node:crypto';
import { MAX_VIEWS_PER_LIST } from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { openList } from './structure.js';

/*
 * Saved views: a person's named ways of looking at a list. Each person sees
 * and changes only their own, and only for lists they can still open.
 */

export interface SavedView {
  id: string;
  listId: string;
  name: string;
  kind: 'list' | 'board';
  query: string;
  updatedAt: Date;
}

interface ViewRow {
  id: string;
  list_id: string;
  name: string;
  kind: 'list' | 'board';
  query: string;
  updated_at: Date;
}

const toView = (row: ViewRow): SavedView => ({
  id: row.id,
  listId: row.list_id,
  name: row.name,
  kind: row.kind,
  query: row.query,
  updatedAt: row.updated_at,
});

export async function listViews(tx: Tx, actor: Actor, listId: string): Promise<SavedView[]> {
  await openList(tx, actor, listId, 'view');
  const found = await rows<ViewRow>(
    tx,
    sql`SELECT id, list_id, name, kind, query, updated_at FROM app.saved_views
        WHERE list_id = ${listId} AND user_id = ${actor.userId}
        ORDER BY lower(name), id`,
  );
  return found.map(toView);
}

async function nameTaken(
  tx: Tx,
  actor: Actor,
  listId: string,
  name: string,
  except: string | null,
): Promise<boolean> {
  const row = await one<{ id: string }>(
    tx,
    sql`SELECT id FROM app.saved_views
        WHERE list_id = ${listId} AND user_id = ${actor.userId} AND lower(name) = lower(${name})
          AND id IS DISTINCT FROM ${except}::uuid`,
  );
  return row !== undefined;
}

export async function createView(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: { name: string; kind: 'list' | 'board'; query: string },
): Promise<SavedView> {
  await openList(tx, actor, listId, 'view');
  if (await nameTaken(tx, actor, listId, body.name, null)) throw conflict('view_name_taken');
  const count = await one<{ n: number }>(
    tx,
    sql`SELECT count(*)::int AS n FROM app.saved_views
        WHERE list_id = ${listId} AND user_id = ${actor.userId}`,
  );
  if ((count?.n ?? 0) >= MAX_VIEWS_PER_LIST) throw badRequest('too_many_views');
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.saved_views (id, list_id, name, kind, query)
        VALUES (${id}, ${listId}, ${body.name}, ${body.kind}, ${body.query})`,
  );
  const row = await one<ViewRow>(
    tx,
    sql`SELECT id, list_id, name, kind, query, updated_at FROM app.saved_views WHERE id = ${id}`,
  );
  if (!row) throw notFound();
  return toView(row);
}

/** One's own view, of a list one can still open; anything else is not found. */
async function ownView(tx: Tx, actor: Actor, viewId: string): Promise<ViewRow> {
  const row = await one<ViewRow>(
    tx,
    sql`SELECT id, list_id, name, kind, query, updated_at FROM app.saved_views
        WHERE id = ${viewId} AND user_id = ${actor.userId}`,
  );
  if (!row) throw notFound();
  await openList(tx, actor, row.list_id, 'view');
  return row;
}

export async function updateView(
  tx: Tx,
  actor: Actor,
  viewId: string,
  body: {
    name?: string | undefined;
    kind?: 'list' | 'board' | undefined;
    query?: string | undefined;
  },
): Promise<SavedView> {
  const row = await ownView(tx, actor, viewId);
  if (body.name !== undefined && (await nameTaken(tx, actor, row.list_id, body.name, viewId))) {
    throw conflict('view_name_taken');
  }
  await run(
    tx,
    sql`UPDATE app.saved_views
        SET name = ${body.name ?? row.name}, kind = ${body.kind ?? row.kind},
            query = ${body.query ?? row.query}
        WHERE id = ${viewId}`,
  );
  const updated = await ownView(tx, actor, viewId);
  return toView(updated);
}

export async function deleteView(tx: Tx, actor: Actor, viewId: string): Promise<void> {
  await ownView(tx, actor, viewId);
  await run(tx, sql`DELETE FROM app.saved_views WHERE id = ${viewId}`);
}
