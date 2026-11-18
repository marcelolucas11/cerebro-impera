import { randomUUID } from 'node:crypto';
import {
  hasCapability,
  MAX_AUTOMATIONS_PER_LIST,
  type AutomationAction,
  type AutomationCondition,
  type AutomationTrigger,
} from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { openList } from './structure.js';

/*
 * Rules of a list. Whoever manages the list sees them; whoever also holds the
 * "automations" capability writes them. A rule acts with the access of whoever
 * saved it last, which the database records and enforces: this module only
 * checks a rule before saving it, so that the person learns what is wrong.
 */

export interface AutomationView {
  id: string;
  listId: string;
  name: string;
  enabled: boolean;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
  /** Whose access it acts with: whoever saved it last. */
  runAs: string;
  runAsName: string;
  createdAt: Date;
  updatedAt: Date;
  lastRun: { at: Date; outcome: RunOutcome } | null;
}

export type RunOutcome = 'done' | 'skipped' | 'failed';

export interface AutomationRunView {
  id: number;
  at: Date;
  outcome: RunOutcome;
  detail: string | null;
  /** Null when the item was removed for good, or the caller does not see it. */
  itemId: string | null;
  itemTitle: string | null;
}

export interface AudienceView {
  id: string;
  name: string;
  /** Can work in the list, so a rule may hand items to them. */
  canWork: boolean;
}

interface Body {
  name: string;
  enabled?: boolean | undefined;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  actions: AutomationAction[];
}

const COLUMNS = `a.id, a.list_id AS "listId", a.name, a.enabled, a.trigger, a.conditions,
  a.actions, a.run_as AS "runAs", u.name AS "runAsName", a.created_at AS "createdAt",
  a.updated_at AS "updatedAt",
  (SELECT json_build_object('at', r.at, 'outcome', r.outcome) FROM app.automation_runs r
   WHERE r.automation_id = a.id ORDER BY r.id DESC LIMIT 1) AS "lastRun"`;
const FROM = 'FROM app.automations a JOIN app.users u ON u.id = a.run_as';

/** What the database says is wrong with a rule, as a code for the person. */
async function check(tx: Tx, listId: string, body: Body): Promise<void> {
  const found = await one<{ problem: string | null }>(
    tx,
    sql`SELECT app.automation_check(${listId}, ${JSON.stringify(body.trigger)}::jsonb,
                                    ${JSON.stringify(body.conditions)}::jsonb,
                                    ${JSON.stringify(body.actions)}::jsonb) AS problem`,
  );
  const problem = found?.problem ?? null;
  if (problem === 'forbidden') throw forbidden();
  if (problem !== null) throw badRequest(problem);
}

function mayWrite(actor: Actor): void {
  if (!hasCapability(actor, 'automations.manage')) throw forbidden();
}

async function findAutomation(tx: Tx, id: string): Promise<AutomationView | undefined> {
  return one<AutomationView>(tx, {
    text: `SELECT ${COLUMNS} ${FROM} WHERE a.id = $1`,
    values: [id],
  });
}

/** The rule and its list opened for managing; not found when the caller cannot see it. */
async function openAutomation(tx: Tx, actor: Actor, id: string): Promise<AutomationView> {
  const found = await findAutomation(tx, id);
  if (!found) throw notFound();
  await openList(tx, actor, found.listId, 'manage');
  return found;
}

export async function listAutomations(
  tx: Tx,
  actor: Actor,
  listId: string,
): Promise<AutomationView[]> {
  await openList(tx, actor, listId, 'manage');
  return rows<AutomationView>(tx, {
    text: `SELECT ${COLUMNS} ${FROM} WHERE a.list_id = $1 ORDER BY a.created_at, a.id`,
    values: [listId],
  });
}

export async function createAutomation(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: Body,
): Promise<AutomationView> {
  await openList(tx, actor, listId, 'manage');
  mayWrite(actor);
  const count = await one<{ count: number }>(
    tx,
    sql`SELECT count(*)::int AS count FROM app.automations WHERE list_id = ${listId}`,
  );
  if ((count?.count ?? 0) >= MAX_AUTOMATIONS_PER_LIST) throw conflict('too_many_automations');
  await check(tx, listId, body);
  const id = randomUUID();
  await run(
    tx,
    sql`INSERT INTO app.automations (id, list_id, name, enabled, trigger, conditions, actions)
        VALUES (${id}, ${listId}, ${body.name}, ${body.enabled ?? true},
                ${JSON.stringify(body.trigger)}::jsonb, ${JSON.stringify(body.conditions)}::jsonb,
                ${JSON.stringify(body.actions)}::jsonb)`,
  );
  await run(
    tx,
    sql`SELECT audit.record('automations.created', 'automation', ${id},
                            jsonb_build_object('list', ${listId}::text))`,
  );
  const created = await findAutomation(tx, id);
  if (!created) throw notFound();
  return created;
}

/** Saving any part of a rule makes it act as whoever saved it. */
export async function updateAutomation(
  tx: Tx,
  actor: Actor,
  id: string,
  body: Partial<Body>,
): Promise<AutomationView> {
  const current = await openAutomation(tx, actor, id);
  mayWrite(actor);
  const next: Body = {
    name: body.name ?? current.name,
    enabled: body.enabled ?? current.enabled,
    trigger: body.trigger ?? current.trigger,
    conditions: body.conditions ?? current.conditions,
    actions: body.actions ?? current.actions,
  };
  await check(tx, current.listId, next);
  await run(
    tx,
    sql`UPDATE app.automations
        SET name = ${next.name}, enabled = ${next.enabled ?? true},
            trigger = ${JSON.stringify(next.trigger)}::jsonb,
            conditions = ${JSON.stringify(next.conditions)}::jsonb,
            actions = ${JSON.stringify(next.actions)}::jsonb
        WHERE id = ${id}`,
  );
  await run(
    tx,
    sql`SELECT audit.record('automations.updated', 'automation', ${id},
                            jsonb_build_object('list', ${current.listId}::text,
                                               'enabled', ${next.enabled ?? true}::boolean))`,
  );
  const updated = await findAutomation(tx, id);
  if (!updated) throw notFound();
  return updated;
}

export async function removeAutomation(tx: Tx, actor: Actor, id: string): Promise<void> {
  const current = await openAutomation(tx, actor, id);
  mayWrite(actor);
  await run(tx, sql`DELETE FROM app.automations WHERE id = ${id}`);
  await run(
    tx,
    sql`SELECT audit.record('automations.removed', 'automation', ${id},
                            jsonb_build_object('list', ${current.listId}::text,
                                               'name', ${current.name}::text))`,
  );
}

/** The latest runs of a rule, newest first. */
export async function automationRuns(
  tx: Tx,
  actor: Actor,
  id: string,
): Promise<AutomationRunView[]> {
  await openAutomation(tx, actor, id);
  return rows<AutomationRunView>(tx, {
    text: `SELECT r.id::int AS id, r.at, r.outcome, r.detail, i.id AS "itemId",
                  i.title AS "itemTitle"
           FROM app.automation_runs r
           LEFT JOIN app.items i ON i.id = r.item_id
           WHERE r.automation_id = $1
           ORDER BY r.id DESC LIMIT 50`,
    values: [id],
  });
}

/** Who a rule of the list may hand work to or tell. */
export async function listAudience(tx: Tx, actor: Actor, listId: string): Promise<AudienceView[]> {
  await openList(tx, actor, listId, 'manage');
  return rows<AudienceView>(tx, {
    text: `SELECT id, name, can_work AS "canWork" FROM app.list_audience($1)`,
    values: [listId],
  });
}

/** Runs older than the database keeps. */
export async function purgeAutomationRuns(db: Tx): Promise<number> {
  const found = await one<{ purged: number }>(
    db,
    sql`SELECT app.purge_automation_runs() AS purged`,
  );
  return found?.purged ?? 0;
}
