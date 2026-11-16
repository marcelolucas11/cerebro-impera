import { randomUUID } from 'node:crypto';
import {
  DEFAULT_OPTION_COLOR,
  MAX_FIELDS_PER_LIST,
  defaultFieldConfig,
  fieldConfigProblem,
  usesOptions,
  type FieldConfig,
  type FieldKind,
  type FieldOption,
} from '@cerebro/shared';
import type { Actor } from '../actor.js';
import { one, rows, run, sql, type Tx } from '../db.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { openList } from './structure.js';

/*
 * Custom fields are what a list records about each item beyond its title.
 * Anyone who can open the list sees which fields it has; only whoever manages
 * the list changes them. Nothing here is ever deleted: fields and options are
 * archived, and what was filled in stays.
 */

export interface FieldView {
  id: string;
  listId: string;
  /** Shared by a field and its copies in other lists. */
  originId: string;
  name: string;
  kind: FieldKind;
  config: FieldConfig;
  position: number;
  archived: boolean;
}

interface FieldRow {
  id: string;
  list_id: string;
  origin_id: string;
  name: string;
  kind: FieldKind;
  config: FieldConfig;
  position: number;
  is_archived: boolean;
}

const toField = (row: FieldRow): FieldView => ({
  id: row.id,
  listId: row.list_id,
  originId: row.origin_id,
  name: row.name,
  kind: row.kind,
  config: row.config,
  position: row.position,
  archived: row.is_archived,
});

const FIELD_COLUMNS = 'id, list_id, origin_id, name, kind, config, position, is_archived';

async function fieldsOf(tx: Tx, listId: string, includeArchived: boolean): Promise<FieldView[]> {
  const found = await rows<FieldRow>(tx, {
    text: `SELECT ${FIELD_COLUMNS} FROM app.list_fields
           WHERE list_id = $1 AND ($2::boolean OR NOT is_archived)
           ORDER BY is_archived, position, created_at`,
    values: [listId, includeArchived],
  });
  return found.map(toField);
}

async function fieldById(tx: Tx, fieldId: string): Promise<FieldView | undefined> {
  const row = await one<FieldRow>(tx, {
    text: `SELECT ${FIELD_COLUMNS} FROM app.list_fields WHERE id = $1`,
    values: [fieldId],
  });
  return row ? toField(row) : undefined;
}

export async function listFields(
  tx: Tx,
  actor: Actor,
  listId: string,
  options: { includeArchived: boolean },
): Promise<FieldView[]> {
  // Archived fields are part of managing the list, not of reading it.
  await openList(tx, actor, listId, options.includeArchived ? 'manage' : 'view');
  return fieldsOf(tx, listId, options.includeArchived);
}

export interface OptionDraft {
  /** Present for an option that already exists; new options get their id here. */
  id?: string | undefined;
  name: string;
  color?: string | undefined;
  archived?: boolean | undefined;
}

export interface ConfigDraft {
  options?: OptionDraft[] | undefined;
  currency?: string | undefined;
  max?: number | undefined;
}

/**
 * Turns what the person sent into the configuration to store. Existing options
 * keep their ids, new ones get an id from the server, and none may be dropped.
 */
function resolveConfig(kind: FieldKind, draft: ConfigDraft, current?: FieldConfig): FieldConfig {
  let config: FieldConfig;
  if (usesOptions(kind)) {
    if (draft.currency !== undefined || draft.max !== undefined) throw badRequest('invalid_field');
    const known = new Map((current?.options ?? []).map((option) => [option.id, option]));
    const options: FieldOption[] = (draft.options ?? []).map((option) => {
      if (option.id !== undefined && !known.has(option.id)) throw badRequest('invalid_option');
      return {
        id: option.id ?? randomUUID(),
        name: option.name,
        color: option.color ?? known.get(option.id ?? '')?.color ?? DEFAULT_OPTION_COLOR,
        ...(option.archived === true ? { archived: true } : {}),
      };
    });
    const kept = new Set(options.map((option) => option.id));
    if ([...known.keys()].some((id) => !kept.has(id))) throw conflict('option_cannot_be_removed');
    config = { options };
  } else {
    if (draft.options !== undefined) throw badRequest('invalid_field');
    config = { ...defaultFieldConfig(kind), ...(current ?? {}) };
    if (draft.currency !== undefined) config.currency = draft.currency;
    if (draft.max !== undefined) config.max = draft.max;
  }
  if (fieldConfigProblem(kind, config) !== null) throw badRequest('invalid_field');
  return config;
}

export async function createField(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: { name: string; kind: FieldKind; config?: ConfigDraft | undefined },
): Promise<FieldView> {
  await openList(tx, actor, listId, 'manage');
  const existing = await fieldsOf(tx, listId, false);
  if (existing.length >= MAX_FIELDS_PER_LIST) throw conflict('too_many_fields');
  const config = resolveConfig(body.kind, body.config ?? {});
  const id = randomUUID();
  const position = Math.max(-1, ...existing.map((field) => field.position)) + 1;
  await run(
    tx,
    sql`INSERT INTO app.list_fields (id, list_id, name, kind, config, position)
        VALUES (${id}, ${listId}, ${body.name}, ${body.kind}, ${JSON.stringify(config)}::jsonb,
                ${position})`,
  );
  const created = await fieldById(tx, id);
  if (!created) throw notFound();
  return created;
}

/** The field, when the caller may manage the list it belongs to. */
async function openField(tx: Tx, actor: Actor, fieldId: string): Promise<FieldView> {
  const field = await fieldById(tx, fieldId);
  if (!field) throw notFound();
  await openList(tx, actor, field.listId, 'manage');
  return field;
}

export async function updateField(
  tx: Tx,
  actor: Actor,
  fieldId: string,
  body: {
    name?: string | undefined;
    config?: ConfigDraft | undefined;
    archived?: boolean | undefined;
  },
): Promise<FieldView> {
  const field = await openField(tx, actor, fieldId);
  if (body.config !== undefined && field.kind === 'rating') {
    // Ratings already given were given on this scale.
    throw conflict('rating_scale_is_fixed');
  }
  const config =
    body.config === undefined ? null : resolveConfig(field.kind, body.config, field.config);
  if (body.archived === false && field.archived) {
    const active = await fieldsOf(tx, field.listId, false);
    if (active.length >= MAX_FIELDS_PER_LIST) throw conflict('too_many_fields');
  }
  await run(
    tx,
    sql`UPDATE app.list_fields SET
          name = coalesce(${body.name ?? null}, name),
          config = coalesce(${config === null ? null : JSON.stringify(config)}::jsonb, config),
          is_archived = coalesce(${body.archived ?? null}::boolean, is_archived)
        WHERE id = ${fieldId}`,
  );
  const updated = await fieldById(tx, fieldId);
  if (!updated) throw notFound();
  return updated;
}

/** Sets the order of all the fields of a list at once: the ids must be exactly its active fields. */
export async function reorderFields(
  tx: Tx,
  actor: Actor,
  listId: string,
  ids: readonly string[],
): Promise<FieldView[]> {
  await openList(tx, actor, listId, 'manage');
  const current = await fieldsOf(tx, listId, false);
  const wanted = new Set(ids);
  if (wanted.size !== ids.length || wanted.size !== current.length) {
    throw badRequest('invalid_order');
  }
  if (!current.every((field) => wanted.has(field.id))) throw badRequest('invalid_order');
  for (const [position, id] of ids.entries()) {
    await run(tx, sql`UPDATE app.list_fields SET position = ${position} WHERE id = ${id}`);
  }
  return fieldsOf(tx, listId, false);
}

/**
 * Copies fields from a list the person can open into a list they manage. A
 * copy keeps the origin of the field it came from, so both count as the same
 * field in totals across lists. Fields the destination already has are left
 * alone and reported back.
 */
export async function copyFields(
  tx: Tx,
  actor: Actor,
  listId: string,
  body: { fromListId: string; fieldIds?: readonly string[] | undefined },
): Promise<{ created: FieldView[]; skipped: string[] }> {
  await openList(tx, actor, listId, 'manage');
  if (body.fromListId === listId) throw badRequest('invalid_list');
  await openList(tx, actor, body.fromListId, 'view');

  const available = await fieldsOf(tx, body.fromListId, false);
  let source = available;
  if (body.fieldIds !== undefined) {
    const byId = new Map(available.map((field) => [field.id, field]));
    source = body.fieldIds.map((id) => {
      const field = byId.get(id);
      if (!field) throw badRequest('invalid_field');
      return field;
    });
  }

  const existing = await fieldsOf(tx, listId, false);
  const names = new Set(existing.map((field) => field.name.toLowerCase()));
  const origins = new Set(existing.map((field) => field.originId));
  let position = Math.max(-1, ...existing.map((field) => field.position)) + 1;
  const created: FieldView[] = [];
  const skipped: string[] = [];
  for (const field of source) {
    if (names.has(field.name.toLowerCase()) || origins.has(field.originId)) {
      skipped.push(field.name);
      continue;
    }
    if (existing.length + created.length >= MAX_FIELDS_PER_LIST) throw conflict('too_many_fields');
    // Archived options are history of the list they came from; a copy starts clean.
    const config: FieldConfig = usesOptions(field.kind)
      ? { options: (field.config.options ?? []).filter((option) => option.archived !== true) }
      : field.config;
    const id = randomUUID();
    await run(
      tx,
      sql`INSERT INTO app.list_fields (id, list_id, origin_id, name, kind, config, position)
          VALUES (${id}, ${listId}, ${field.originId}, ${field.name}, ${field.kind},
                  ${JSON.stringify(config)}::jsonb, ${position})`,
    );
    position += 1;
    names.add(field.name.toLowerCase());
    origins.add(field.originId);
    const copy = await fieldById(tx, id);
    if (!copy) throw notFound();
    created.push(copy);
  }
  return { created, skipped };
}
