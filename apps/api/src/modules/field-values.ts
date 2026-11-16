import {
  fieldValueProblem,
  type FieldConfig,
  type FieldKind,
  type FieldValue,
} from '@cerebro/shared';
import { rows, run, sql, type Tx } from '../db.js';
import { badRequest } from '../http/errors.js';

/**
 * Writes the values of an item's fields. `null` clears a field. Every field
 * must be an active field of the item's own list, and every value must fit it.
 */
export async function writeFieldValues(
  tx: Tx,
  listId: string,
  itemId: string,
  changes: Readonly<Record<string, FieldValue | null>>,
): Promise<void> {
  const ids = Object.keys(changes);
  if (ids.length === 0) return;
  const fields = new Map(
    (
      await rows<{ id: string; kind: FieldKind; config: FieldConfig }>(
        tx,
        sql`SELECT id, kind, config FROM app.list_fields
            WHERE list_id = ${listId} AND NOT is_archived AND id = ANY (${ids}::uuid[])`,
      )
    ).map((field) => [field.id, field] as const),
  );
  const current = new Map(
    (
      await rows<{ field_id: string; value: FieldValue }>(
        tx,
        sql`SELECT field_id, value FROM app.item_field_values
            WHERE item_id = ${itemId} AND field_id = ANY (${ids}::uuid[])`,
      )
    ).map((row) => [row.field_id, row.value] as const),
  );
  for (const [fieldId, value] of Object.entries(changes)) {
    const field = fields.get(fieldId);
    if (!field) throw badRequest('invalid_field');
    if (value === null) {
      await run(
        tx,
        sql`DELETE FROM app.item_field_values WHERE item_id = ${itemId} AND field_id = ${fieldId}`,
      );
      continue;
    }
    const problem = fieldValueProblem(field.kind, field.config, value, current.get(fieldId));
    if (problem !== null) throw badRequest('invalid_field_value', { fieldId, problem });
    await run(
      tx,
      sql`INSERT INTO app.item_field_values (item_id, field_id, value)
          VALUES (${itemId}, ${fieldId}, ${JSON.stringify(value)}::jsonb)
          ON CONFLICT (item_id, field_id) DO UPDATE SET value = EXCLUDED.value`,
    );
  }
}
