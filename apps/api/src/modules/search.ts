import type { Actor } from '../actor.js';
import { rows, sql, type Tx } from '../db.js';

/*
 * Finding items across every list the person can open. The query reads
 * items under the same row-level rules as the lists themselves: what is not
 * theirs to see is never found, and a sensitive list without a recent second
 * factor is simply not searched.
 */

export interface SearchHit {
  id: string;
  title: string;
  listId: string;
  listName: string;
  stageName: string;
  /** True when the words were found in the title; otherwise in the description. */
  inTitle: boolean;
  updatedAt: Date;
}

const LIMIT = 30;

/** Turns typed words into LIKE patterns that match them literally. */
export function patternsOf(query: string): string[] {
  return query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((word) => `%${word.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
}

export async function search(tx: Tx, _actor: Actor, query: string): Promise<SearchHit[]> {
  const patterns = patternsOf(query);
  if (patterns.length === 0) return [];
  const found = await rows<{
    id: string;
    title: string;
    list_id: string;
    list_name: string;
    stage_name: string;
    in_title: boolean;
    updated_at: Date;
  }>(
    tx,
    sql`SELECT i.id, i.title, i.list_id, l.name AS list_name, s.name AS stage_name,
               (SELECT bool_and(app.plain(i.title) LIKE app.plain(p))
                FROM unnest(${patterns}::text[]) AS p) AS in_title,
               i.updated_at
        FROM app.items i
        JOIN app.lists l ON l.id = i.list_id AND NOT l.is_archived
        JOIN app.list_stages s ON s.id = i.stage_id
        WHERE i.deleted_at IS NULL
          AND (SELECT bool_and(app.plain(i.title || ' ' || i.description) LIKE app.plain(p))
               FROM unnest(${patterns}::text[]) AS p)
        ORDER BY in_title DESC, i.updated_at DESC, i.id
        LIMIT ${LIMIT}`,
  );
  return found.map((row) => ({
    id: row.id,
    title: row.title,
    listId: row.list_id,
    listName: row.list_name,
    stageName: row.stage_name,
    inTitle: row.in_title,
    updatedAt: row.updated_at,
  }));
}
