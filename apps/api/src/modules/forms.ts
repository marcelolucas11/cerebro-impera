import { isFormFieldKind, type FormInput, type FormView } from '@cerebro/shared';
import { requireStepUp, type Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { openList } from './structure.js';

/*
 * Public forms, as whoever manages a list sees them. Writing one asks for the
 * code again: a form is a door into the list for anyone with its address. The
 * database checks the fields it asks and the stage it sends to, and makes the
 * form send with the access of whoever saved it last.
 */

interface FormRow {
  id: string;
  listId: string;
  slug: string;
  title: string;
  intro: string;
  titleLabel: string;
  descriptionLabel: string | null;
  fields: { id: string; required: boolean }[];
  stageId: string | null;
  enabled: boolean;
  sentToday: number;
  sentTotal: number;
  updatedAt: Date;
}

const COLUMNS = `f.id, f.list_id AS "listId", f.slug, f.title, f.intro, f.title_label AS "titleLabel",
  f.description_label AS "descriptionLabel", f.fields, f.stage_id AS "stageId", f.enabled,
  f.updated_at AS "updatedAt",
  (SELECT count(*)::int FROM app.form_submissions s
   WHERE s.form_id = f.id AND s.at > now() - interval '1 day') AS "sentToday",
  (SELECT count(*)::int FROM app.form_submissions s WHERE s.form_id = f.id) AS "sentTotal"`;

export const MAX_FORMS_PER_LIST = 20;

function view(deps: Deps, row: FormRow): FormView {
  const origin = deps.config.formsOrigin;
  return {
    id: row.id,
    listId: row.listId,
    title: row.title,
    intro: row.intro,
    titleLabel: row.titleLabel,
    descriptionLabel: row.descriptionLabel,
    fields: row.fields,
    stageId: row.stageId,
    enabled: row.enabled,
    address: origin === null ? null : `${origin}/f/${row.slug}`,
    sentToday: row.sentToday,
    sentTotal: row.sentTotal,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function find(tx: Tx, id: string): Promise<FormRow | undefined> {
  return one<FormRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.forms f WHERE f.id = $1`,
    values: [id],
  });
}

/** The form and its list opened for managing; not found when the caller cannot see it. */
async function openForm(tx: Tx, actor: Actor, id: string): Promise<FormRow> {
  const found = await find(tx, id);
  if (!found) throw notFound();
  await openList(tx, actor, found.listId, 'manage');
  return found;
}

/** What the database would refuse, said first in words the page can show. */
async function check(tx: Tx, listId: string, body: FormInput): Promise<void> {
  const ids = body.fields.map((field) => field.id);
  const found = await rows<{ id: string; kind: string }>(
    tx,
    sql`SELECT id, kind FROM app.list_fields
        WHERE list_id = ${listId} AND NOT is_archived AND id = ANY (${ids}::uuid[])`,
  );
  if (found.length !== ids.length || found.some((field) => !isFormFieldKind(field.kind))) {
    throw badRequest('form_fields');
  }
  if (body.stageId !== null) {
    const stage = await one<{ id: string }>(
      tx,
      sql`SELECT id FROM app.list_stages WHERE id = ${body.stageId} AND list_id = ${listId}`,
    );
    if (!stage) throw badRequest('form_stage');
  }
}

export async function listForms(
  tx: Tx,
  deps: Deps,
  actor: Actor,
  listId: string,
): Promise<FormView[]> {
  await openList(tx, actor, listId, 'manage');
  const found = await rows<FormRow>(tx, {
    text: `SELECT ${COLUMNS} FROM app.forms f WHERE f.list_id = $1 ORDER BY f.created_at, f.id`,
    values: [listId],
  });
  return found.map((row) => view(deps, row));
}

export async function createForm(
  tx: Tx,
  deps: Deps,
  actor: Actor,
  listId: string,
  body: FormInput,
): Promise<FormView> {
  await openList(tx, actor, listId, 'manage');
  requireStepUp(actor);
  const count = await one<{ count: number }>(
    tx,
    sql`SELECT count(*)::int AS count FROM app.forms WHERE list_id = ${listId}`,
  );
  if ((count?.count ?? 0) >= MAX_FORMS_PER_LIST) throw conflict('too_many_forms');
  await check(tx, listId, body);
  const created = await one<{ id: string }>(
    tx,
    sql`INSERT INTO app.forms (list_id, title, intro, title_label, description_label, fields,
                               stage_id, enabled)
        VALUES (${listId}, ${body.title}, ${body.intro}, ${body.titleLabel},
                ${body.descriptionLabel}, ${JSON.stringify(body.fields)}::jsonb, ${body.stageId},
                ${body.enabled})
        RETURNING id`,
  );
  const row = created ? await find(tx, created.id) : undefined;
  if (!row) throw notFound();
  return view(deps, row);
}

/** Saving any part of a form makes it send as whoever saved it. */
export async function updateForm(
  tx: Tx,
  deps: Deps,
  actor: Actor,
  id: string,
  body: FormInput,
): Promise<FormView> {
  const current = await openForm(tx, actor, id);
  requireStepUp(actor);
  await check(tx, current.listId, body);
  await run(
    tx,
    sql`UPDATE app.forms
        SET title = ${body.title}, intro = ${body.intro}, title_label = ${body.titleLabel},
            description_label = ${body.descriptionLabel},
            fields = ${JSON.stringify(body.fields)}::jsonb, stage_id = ${body.stageId},
            enabled = ${body.enabled}
        WHERE id = ${id}`,
  );
  const row = await find(tx, id);
  if (!row) throw notFound();
  return view(deps, row);
}

export async function removeForm(tx: Tx, actor: Actor, id: string): Promise<void> {
  await openForm(tx, actor, id);
  requireStepUp(actor);
  await run(tx, sql`DELETE FROM app.forms WHERE id = ${id}`);
}
