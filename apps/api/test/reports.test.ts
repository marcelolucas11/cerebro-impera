import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { attempt, bind, buildScenario, connectAs, type Scenario } from './support/scenario.js';

/*
 * The weekly report: written by the routine, once per week, never inside a
 * person's request; read by owners, and by whoever an owner hands the
 * capability, over the lists where they see every item. By the API and at the
 * database.
 */

interface Totals {
  created: number;
  finished: number;
  open: number;
  overdue: number;
}
interface Report {
  id: string;
  weekStart: string;
  totals: Totals;
  previous: Totals | null;
  lists: (Totals & { listId: string; listName: string; spaceName: string })[];
  people: {
    userId: string;
    name: string | null;
    finished: number;
    open: number;
    overdue: number;
  }[];
}

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let thisWeek: string;
let lastWeek: string;

const make = async (week?: string): Promise<number | string> => {
  try {
    const made = await app.query<{ made: number }>(
      week === undefined
        ? 'SELECT app.weekly_report_make() AS made'
        : 'SELECT app.weekly_report_make($1::date) AS made',
      week === undefined ? [] : [week],
    );
    return made.rows[0]?.made ?? -1;
  } catch (error) {
    return (error as { code?: string }).code ?? 'error';
  }
};
const listOf = (person: Person) =>
  person.browser.get<{ id: string; weekStart: string }[] & { error?: { code: string } }>(
    '/api/reports',
  );
const reportOf = async (person: Person, week: string): Promise<Report> => {
  const found = (await listOf(person)).body.find((one) => one.weekStart === week);
  if (found === undefined) throw new Error(`no report for ${week}`);
  return (await person.browser.get<Report>(`/api/reports/${found.id}`)).body;
};
const giveReports = (person: Person): Promise<unknown> =>
  env.admin.query(
    `INSERT INTO app.user_capabilities (user_id, capability, granted_by)
     VALUES ($1, 'reports.view', $2)`,
    [person.id, s.owner.id],
  );
const confirmCode = (person: Person): Promise<unknown> =>
  env.admin.query(
    `UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [person.id],
  );

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  const weeks = await env.admin.query<{ now: string; before: string }>(
    `SELECT date_trunc('week', current_date)::date::text AS now,
            (date_trunc('week', current_date)::date - 7)::text AS before`,
  );
  thisWeek = weeks.rows[0]?.now ?? '';
  lastWeek = weeks.rows[0]?.before ?? '';

  // Tarefas this week: Ana's is late, Bruno's was finished, nobody's went to the trash.
  const done =
    (
      await s.owner.browser.get<{ id: string; kind: string }[]>(`/api/lists/${s.tarefas}/stages`)
    ).body.find((stage) => stage.kind === 'done')?.id ?? '';
  await s.owner.browser.patch(`/api/items/${s.itemBruno}`, { stageId: done });
  // Due on last week's Monday: late in both reports.
  await s.owner.browser.patch(`/api/items/${s.itemAna}`, { dueDate: lastWeek });
  await s.owner.browser.post(`/api/items/${s.itemNobody}/trash`);
  // Dinheiro: the owner's, due today, so not late yet.
  await confirmCode(s.owner);
  const today = (await env.admin.query<{ d: string }>(`SELECT current_date::text AS d`)).rows[0]?.d;
  await s.owner.browser.patch(`/api/items/${s.itemMoney}`, { dueDate: today });
  await s.owner.browser.put(`/api/items/${s.itemMoney}/assignees`, { userIds: [s.owner.id] });
});
afterAll(async () => {
  await app.end();
  await env.close();
});

describe('the weekly report is made', () => {
  it('by the routine, once a week, for a Monday that has come, never inside a request', async () => {
    expect(await make()).toBe(1);
    expect(await make()).toBe(0);
    expect(await make(thisWeek)).toBe(1);
    expect(await make(thisWeek)).toBe(0);
    const tuesday = (
      await env.admin.query<{ d: string }>(`SELECT ($1::date + 1)::text AS d`, [thisWeek])
    ).rows[0]?.d;
    const nextWeek = (
      await env.admin.query<{ d: string }>(`SELECT ($1::date + 7)::text AS d`, [thisWeek])
    ).rows[0]?.d;
    expect(await make(tuesday)).toBe('22023');
    expect(await make(nextWeek)).toBe('22023');

    expect(await bind(app, s.owner)).toBe(true);
    expect(await attempt(app, 'SELECT app.weekly_report_make()')).toMatchObject({
      ok: false,
      code: 'CB001',
    });
    await app.query('ROLLBACK');
  });

  it('with what came in, was finished, is open and is late, per list and per person', async () => {
    await confirmCode(s.owner);
    const report = await reportOf(s.owner, thisWeek);
    expect(
      report.lists.map((line) => [
        line.listName,
        line.created,
        line.finished,
        line.open,
        line.overdue,
      ]),
    ).toEqual([
      ['Dinheiro', 1, 0, 1, 0],
      ['Tarefas', 2, 1, 1, 1],
    ]);
    expect(report.totals).toEqual({ created: 3, finished: 1, open: 2, overdue: 1 });
    expect(report.people.map((one) => [one.name, one.finished, one.open, one.overdue])).toEqual([
      ['Ana Souza', 0, 1, 1],
      ['Dona Primeira', 0, 1, 0],
      ['Bruno Lima', 1, 0, 0],
    ]);
    // Last week nothing came in or was finished; what is open now was counted.
    expect(report.previous).toEqual({ created: 0, finished: 0, open: 2, overdue: 1 });
  });
});

describe('the weekly report is read', () => {
  it('by owners, and a sensitive list only after the code', async () => {
    await expireStepUp(env, s.owner);
    const locked = await reportOf(s.owner, thisWeek);
    expect(locked.lists.map((line) => line.listName)).toEqual(['Tarefas']);
    expect(locked.totals.open).toBe(1);
    expect(locked.people.map((one) => one.name)).toEqual(['Ana Souza', 'Bruno Lima']);
    // The page may ask for the code first, to read the sensitive lists too.
    const asked = await s.owner.browser.get<{ error: { code: string } }>(
      `/api/reports/${locked.id}?sensitive=1`,
    );
    expect(asked.status).toBe(403);
    expect(asked.body.error.code).toBe('step_up_required');
    await confirmCode(s.owner);
    const whole = await s.owner.browser.get<Report>(`/api/reports/${locked.id}?sensitive=1`);
    expect(whole.body.lists.map((line) => line.listName)).toEqual(['Dinheiro', 'Tarefas']);
  });

  it('by others only with the capability, over the lists where they see every item', async () => {
    for (const person of [s.ana, s.marta, s.nuno]) {
      expect((await listOf(person)).status, person.id).toBe(403);
    }
    await giveReports(s.marta);
    const hers = await reportOf(s.marta, thisWeek);
    expect(hers.lists.map((line) => line.listName)).toEqual(['Tarefas']);
    expect(hers.people.map((one) => one.name)).toEqual(['Ana Souza', 'Bruno Lima']);
    // Ana sees only her own items in Tarefas: no line is hers to read.
    await giveReports(s.ana);
    const anas = await reportOf(s.ana, thisWeek);
    expect(anas.lists).toEqual([]);
    expect(anas.people).toEqual([]);
    expect(anas.totals).toEqual({ created: 0, finished: 0, open: 0, overdue: 0 });
    expect(
      (await s.ana.browser.get('/api/reports/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
  });
});

describe('at the database', () => {
  it('nobody but the routine writes a report, and the capability is needed to read one', async () => {
    const reportId = (
      await env.admin.query<{ id: string }>(
        'SELECT id FROM app.weekly_reports WHERE week_start = $1',
        [thisWeek],
      )
    ).rows[0]?.id;

    // Seeing every item of a list is not enough without the capability.
    await env.admin.query(
      `DELETE FROM app.user_capabilities WHERE user_id = $1 AND capability = 'reports.view'`,
      [s.marta.id],
    );
    for (const person of [s.bruno, s.marta]) {
      expect(await bind(app, person)).toBe(true);
      for (const table of ['weekly_reports', 'weekly_report_lists', 'weekly_report_people']) {
        expect((await attempt(app, `SELECT * FROM app.${table}`)).rowCount, table).toBe(0);
      }
      expect((await attempt(app, 'SELECT * FROM app.report_names($1)', [reportId])).rowCount).toBe(
        0,
      );
      await app.query('ROLLBACK');
    }
    await giveReports(s.marta);

    expect(await bind(app, s.marta)).toBe(true);
    // Tarefas in each report, never Dinheiro: Ana and Bruno this week, Ana alone the week
    // before (Bruno's was finished only this week); and only the names on Tarefas.
    expect((await attempt(app, 'SELECT * FROM app.weekly_report_lists')).rows).toHaveLength(2);
    expect((await attempt(app, 'SELECT * FROM app.weekly_report_people')).rows).toHaveLength(3);
    expect(
      (await attempt(app, 'SELECT name FROM app.report_names($1) ORDER BY name', [reportId])).rows,
    ).toEqual([{ name: 'Ana Souza' }, { name: 'Bruno Lima' }]);
    for (const statement of [
      `INSERT INTO app.weekly_reports (week_start) VALUES ('2020-01-06')`,
      'UPDATE app.weekly_report_lists SET open = 0',
      'UPDATE app.weekly_report_people SET overdue = 0',
      'DELETE FROM app.weekly_report_people',
      'DELETE FROM app.weekly_report_lists',
      'DELETE FROM app.weekly_reports',
      `SELECT * FROM app.report_items(now() - interval '7 days', now())`,
    ]) {
      expect(await attempt(app, statement), statement).toMatchObject({ ok: false, code: '42501' });
    }
    await app.query('ROLLBACK');

    const code = (statement: string, values: unknown[] = []): Promise<string> =>
      env.admin.query(statement, values).then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code ?? 'error',
      );
    expect(await code(`INSERT INTO app.weekly_reports (week_start) VALUES ('2020-01-07')`)).toBe(
      '23514',
    );
    expect(
      await code('UPDATE app.weekly_report_lists SET overdue = open + 1 WHERE report_id = $1', [
        reportId,
      ]),
    ).toBe('23514');
    expect(
      await code(
        `INSERT INTO app.user_capabilities (user_id, capability, granted_by) VALUES ($1, 'tudo', $2)`,
        [s.bruno.id, s.owner.id],
      ),
    ).toBe('23514');
  });
});
