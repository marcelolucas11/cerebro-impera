import { requireCapability, type Actor } from '../actor.js';
import { one, run, sql, type Tx } from '../db.js';
import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../http/errors.js';
import { openItem } from './structure.js';

/*
 * Secret fields. The value is sealed here, bound to its item and field, and
 * the database keeps it where this API cannot read it back. Revealing goes
 * through the database, which asks for a recent second factor and records it.
 */

const PURPOSE = 'field-secret';
const context = (itemId: string, fieldId: string): string => `${itemId}/${fieldId}`;

/** The field, when it is an active secret field of the item's own list. */
async function secretField(tx: Tx, listId: string, fieldId: string): Promise<void> {
  const field = await one<{ id: string }>(
    tx,
    sql`SELECT id FROM app.list_fields
        WHERE id = ${fieldId} AND list_id = ${listId} AND kind = 'secret' AND NOT is_archived`,
  );
  if (!field) throw badRequest('invalid_field');
}

/** Keeps a new value, or clears it with null. Whoever edits the item may. */
export async function setSecret(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  itemId: string,
  fieldId: string,
  value: string | null,
): Promise<{ set: boolean }> {
  const { item } = await openItem(tx, actor, itemId, 'edit');
  await secretField(tx, item.listId, fieldId);
  if (value === null) {
    await run(
      tx,
      sql`DELETE FROM app.item_secrets WHERE item_id = ${itemId} AND field_id = ${fieldId}`,
    );
    return { set: false };
  }
  const sealed = deps.vault.seal(PURPOSE, context(itemId, fieldId), Buffer.from(value, 'utf8'));
  // Replace, or keep for the first time. (No upsert: that would need the right
  // to read the sealed column, which the API does not have.)
  const replaced = await run(
    tx,
    sql`UPDATE app.item_secrets SET sealed = ${sealed}
        WHERE item_id = ${itemId} AND field_id = ${fieldId}`,
  );
  if (replaced === 0) {
    await run(
      tx,
      sql`INSERT INTO app.item_secrets (item_id, field_id, sealed)
          VALUES (${itemId}, ${fieldId}, ${sealed})`,
    );
  }
  return { set: true };
}

/**
 * The value, for whoever sees the item and may reveal secrets, after the
 * database has put it on the record.
 */
export async function revealSecret(
  deps: Deps,
  tx: Tx,
  actor: Actor,
  itemId: string,
  fieldId: string,
): Promise<{ value: string }> {
  requireCapability(actor, 'secret_fields.reveal');
  const { item } = await openItem(tx, actor, itemId, 'view');
  await secretField(tx, item.listId, fieldId);
  const row = await one<{ sealed: Buffer | null }>(
    tx,
    sql`SELECT app.reveal_secret(${itemId}, ${fieldId}) AS sealed`,
  );
  if (!row?.sealed) throw notFound();
  return {
    value: deps.vault.open(PURPOSE, context(itemId, fieldId), row.sealed).toString('utf8'),
  };
}
