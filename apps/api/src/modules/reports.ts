import { hasCapability } from '@cerebro/shared';
import { requireStepUp, type Actor } from '../actor.js';
import { one, rows, sql, type Tx } from '../db.js';
import { forbidden, notFound } from '../http/errors.js';

/*
 * The weekly report: per list, what came in, what was finished, what is open
 * and what is late; and per person on those lists. The routine writes it; it is
 * read with the reader's access, so someone handed the capability reads only the
 * lists where they see every item (a sensitive one after the code).
 */

export interface ReportTotals {
  created: number;
  finished: number;
  open: number;
  overdue: number;
}

export interface WeeklyReport {
  id: string;
  /** Monday, YYYY-MM-DD. */
  weekStart: string;
  madeAt: string;
  totals: ReportTotals;
  /** The week before, over the same lists this person reads; null when there is none. */
  previous: ReportTotals | null;
  lists: (ReportTotals & { listId: string; listName: string; spaceName: string })[];
  people: {
    userId: string;
    name: string | null;
    finished: number;
    open: number;
    overdue: number;
  }[];
}

const NO_TOTALS: ReportTotals = { created: 0, finished: 0, open: 0, overdue: 0 };

function mayRead(actor: Actor): void {
  if (!hasCapability(actor, 'reports.view')) throw forbidden();
}

export async function reports(
  tx: Tx,
  actor: Actor,
): Promise<{ id: string; weekStart: string; madeAt: string }[]> {
  mayRead(actor);
  return rows(
    tx,
    sql`SELECT id, week_start::text AS "weekStart", made_at AS "madeAt"
        FROM app.weekly_reports ORDER BY week_start DESC LIMIT 60`,
  );
}

async function totalsOf(tx: Tx, reportId: string): Promise<ReportTotals> {
  const found = await one<ReportTotals>(
    tx,
    sql`SELECT coalesce(sum(created), 0)::int AS created, coalesce(sum(finished), 0)::int AS finished,
               coalesce(sum(open), 0)::int AS open, coalesce(sum(overdue), 0)::int AS overdue
        FROM app.weekly_report_lists WHERE report_id = ${reportId}`,
  );
  return found ?? NO_TOTALS;
}

/**
 * One report. With `sensitive`, the code must have been confirmed recently, so
 * the page can ask for it before reading the sensitive lists too.
 */
export async function report(
  tx: Tx,
  actor: Actor,
  reportId: string,
  options: { sensitive: boolean } = { sensitive: false },
): Promise<WeeklyReport> {
  mayRead(actor);
  if (options.sensitive) requireStepUp(actor);
  const found = await one<{ id: string; weekStart: string; madeAt: string }>(
    tx,
    sql`SELECT id, week_start::text AS "weekStart", made_at AS "madeAt"
        FROM app.weekly_reports WHERE id = ${reportId}`,
  );
  if (!found) throw notFound();

  const lists = await rows<WeeklyReport['lists'][number]>(
    tx,
    sql`SELECT r.list_id AS "listId", l.name AS "listName", sp.name AS "spaceName",
               r.created, r.finished, r.open, r.overdue
        FROM app.weekly_report_lists r
        JOIN app.lists l ON l.id = r.list_id
        JOIN app.spaces sp ON sp.id = l.space_id
        WHERE r.report_id = ${reportId}
        ORDER BY sp.name, l.name, r.list_id`,
  );
  const people = await rows<{ userId: string; finished: number; open: number; overdue: number }>(
    tx,
    sql`SELECT user_id AS "userId", sum(finished)::int AS finished, sum(open)::int AS open,
               sum(overdue)::int AS overdue
        FROM app.weekly_report_people WHERE report_id = ${reportId}
        GROUP BY user_id`,
  );
  const names = new Map(
    (
      await rows<{ id: string; name: string }>(
        tx,
        sql`SELECT id, name FROM app.report_names(${reportId})`,
      )
    ).map((person) => [person.id, person.name]),
  );
  const before = await one<{ id: string }>(
    tx,
    sql`SELECT id FROM app.weekly_reports WHERE week_start = ${found.weekStart}::date - 7`,
  );

  return {
    ...found,
    totals: await totalsOf(tx, reportId),
    previous: before ? await totalsOf(tx, before.id) : null,
    lists,
    people: people
      .map((person) => ({ ...person, name: names.get(person.userId) ?? null }))
      .sort(
        (a, b) =>
          b.overdue - a.overdue ||
          b.open - a.open ||
          (a.name ?? '').localeCompare(b.name ?? '', 'pt-BR'),
      ),
  };
}

/** Writes last week's report when it is not there yet; run by the hourly routine. */
export async function makeWeeklyReport(db: Tx): Promise<number> {
  const made = await one<{ made: number }>(db, sql`SELECT app.weekly_report_make() AS made`);
  return made?.made ?? 0;
}
