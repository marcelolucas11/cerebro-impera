import type { Actor } from '../actor.js';
import { one, rows, type Tx } from '../db.js';
import { openList } from './structure.js';

/*
 * The numbers of a list: how many items in each stage, with whom, by each
 * choice field, late or due today, and how long items stay in each stage.
 * Counted as the person, so each one counts only what they see in the list;
 * the database holds that too.
 */

export interface ListSummary {
  total: number;
  finished: number;
  overdue: number;
  dueToday: number;
  /** Every stage of the list, in order; time spent is over stays that ended in the last 90 days. */
  byStage: { stageId: string; count: number; averageSeconds: number | null; stays: number }[];
  /** With whom; `userId` null for items with nobody. */
  byAssignee: { userId: string | null; name: string | null; count: number }[];
  /** Each choice field in use; `optionId` null for items without a value. */
  byField: { fieldId: string; options: { optionId: string | null; count: number }[] }[];
}

const VISIBLE = `
  SELECT i.id, i.stage_id, i.due_date FROM app.items i
  WHERE i.list_id = $1 AND i.deleted_at IS NULL
    AND ($2::boolean OR i.created_by = $3 OR EXISTS (
      SELECT 1 FROM app.item_assignees mine WHERE mine.item_id = i.id AND mine.user_id = $3))`;

export async function listSummary(tx: Tx, actor: Actor, listId: string): Promise<ListSummary> {
  const { access } = await openList(tx, actor, listId, 'view');
  const values = [listId, access.itemScope === 'all', actor.userId];

  const totals = await one<{ total: number; finished: number; overdue: number; due_today: number }>(
    tx,
    {
      text: `WITH visible AS (${VISIBLE})
             SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE s.kind IN ('done', 'closed'))::int AS finished,
                    count(*) FILTER (WHERE s.kind NOT IN ('done', 'closed')
                                       AND v.due_date < current_date)::int AS overdue,
                    count(*) FILTER (WHERE s.kind NOT IN ('done', 'closed')
                                       AND v.due_date = current_date)::int AS due_today
             FROM visible v JOIN app.list_stages s ON s.id = v.stage_id`,
      values,
    },
  );

  const byStage = await rows<{
    stageId: string;
    count: number;
    averageSeconds: number | null;
    stays: number;
  }>(tx, {
    text: `WITH visible AS (${VISIBLE}),
           stays AS (
             SELECT h.stage_id, extract(epoch FROM h.left_at - h.entered_at) AS seconds
             FROM app.item_stage_history h JOIN visible v ON v.id = h.item_id
             WHERE h.left_at IS NOT NULL AND h.left_at > now() - interval '90 days'
           )
           SELECT s.id AS "stageId",
                  (SELECT count(*)::int FROM visible v WHERE v.stage_id = s.id) AS count,
                  (SELECT round(avg(st.seconds))::float8 FROM stays st WHERE st.stage_id = s.id)
                    AS "averageSeconds",
                  (SELECT count(*)::int FROM stays st WHERE st.stage_id = s.id) AS stays
           FROM app.list_stages s
           WHERE s.list_id = $1
           ORDER BY s.position, s.created_at`,
    values,
  });

  const assignees = await rows<{ userId: string | null; count: number }>(tx, {
    text: `WITH visible AS (${VISIBLE})
           SELECT ia.user_id AS "userId", count(*)::int AS count
           FROM visible v LEFT JOIN app.item_assignees ia ON ia.item_id = v.id
           GROUP BY ia.user_id
           ORDER BY count(*) DESC, ia.user_id NULLS LAST`,
    values,
  });
  const names = new Map(
    (
      await rows<{ id: string; name: string }>(tx, {
        text: 'SELECT id, name FROM app.assignee_names($1)',
        values: [listId],
      })
    ).map((person) => [person.id, person.name]),
  );

  const fields = await rows<{ fieldId: string; optionId: string | null; count: number }>(tx, {
    text: `WITH visible AS (${VISIBLE})
           SELECT f.id AS "fieldId", fv.value #>> '{}' AS "optionId", count(*)::int AS count
           FROM app.list_fields f
           CROSS JOIN visible v
           LEFT JOIN app.item_field_values fv ON fv.item_id = v.id AND fv.field_id = f.id
           WHERE f.list_id = $1 AND f.kind = 'select' AND NOT f.is_archived
           GROUP BY f.id, f.position, fv.value
           ORDER BY f.position, f.id, count(*) DESC`,
    values,
  });
  const byField: ListSummary['byField'] = [];
  for (const row of fields) {
    let field = byField.find((one) => one.fieldId === row.fieldId);
    if (!field) {
      field = { fieldId: row.fieldId, options: [] };
      byField.push(field);
    }
    field.options.push({ optionId: row.optionId, count: row.count });
  }

  return {
    total: totals?.total ?? 0,
    finished: totals?.finished ?? 0,
    overdue: totals?.overdue ?? 0,
    dueToday: totals?.due_today ?? 0,
    byStage,
    byAssignee: assignees.map((row) => ({
      userId: row.userId,
      name: row.userId === null ? null : (names.get(row.userId) ?? null),
      count: row.count,
    })),
    byField,
  };
}
