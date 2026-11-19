import { z } from 'zod';
import type { FieldKind } from './fields.js';
import { idSchema } from './schemas.js';

/*
 * Public forms: a page anyone can fill in, whose answer arrives as an item of a
 * list. Only these kinds of field are asked of strangers: no people, no files,
 * no secrets, nothing that would show them something of the inside.
 */

export const FORM_FIELD_KINDS = [
  'text',
  'long_text',
  'number',
  'money',
  'date',
  'select',
  'checkbox',
  'url',
  'email',
  'phone',
] as const satisfies readonly FieldKind[];
export type FormFieldKind = (typeof FORM_FIELD_KINDS)[number];

export const isFormFieldKind = (kind: string): kind is FormFieldKind =>
  (FORM_FIELD_KINDS as readonly string[]).includes(kind);

export const MAX_FORM_FIELDS = 20;
export const MAX_FORM_TITLE = 500;
export const MAX_FORM_DESCRIPTION = 5000;

const id = idSchema;
const label = z.string().trim().min(1).max(120);

export const formSchema = z.strictObject({
  title: label,
  intro: z.string().trim().max(2000),
  titleLabel: label,
  descriptionLabel: label.nullable(),
  fields: z
    .array(z.strictObject({ id, required: z.boolean() }))
    .max(MAX_FORM_FIELDS)
    .refine((fields) => new Set(fields.map((f) => f.id)).size === fields.length, {
      message: 'repeated_field',
    }),
  stageId: id.nullable(),
  enabled: z.boolean(),
});
export type FormInput = z.infer<typeof formSchema>;

/** A form as whoever manages the list sees it. */
export interface FormView {
  id: string;
  listId: string;
  title: string;
  intro: string;
  titleLabel: string;
  descriptionLabel: string | null;
  fields: { id: string; required: boolean }[];
  stageId: string | null;
  enabled: boolean;
  /** The address to share, or null when this installation has no forms address yet. */
  address: string | null;
  sentToday: number;
  sentTotal: number;
  updatedAt: string;
}

/** A form as the public page shows it. */
export interface PublicForm {
  title: string;
  intro: string;
  titleLabel: string;
  descriptionLabel: string | null;
  fields: {
    id: string;
    name: string;
    kind: FormFieldKind;
    required: boolean;
    currency: string | null;
    options: { id: string; name: string }[] | null;
  }[];
}
