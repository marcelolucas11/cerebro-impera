import { z } from 'zod';
import { ACCESS_LEVELS, ITEM_SCOPES, SCOPE_TYPES } from './access.js';
import { CAPABILITIES } from './capabilities.js';
import {
  FIELD_KINDS,
  MAX_FIELD_OPTIONS,
  MAX_FIELDS_PER_LIST,
  MAX_LABELS_PER_VALUE,
} from './fields.js';
import { PASSWORD_MAX_LENGTH } from './password.js';
import { ROLES } from './roles.js';
import { MAX_STAGES_PER_LIST, STAGE_KINDS } from './stages.js';

/*
 * Every request body is parsed with a *strict* object: unknown keys are
 * rejected instead of ignored, which shuts the door on mass-assignment.
 */

export const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());
export const nameSchema = z.string().trim().min(1).max(120);
export const idSchema = z.uuid();
// Length is only capped here; the real policy lives in `checkPassword`.
export const passwordSchema = z
  .string()
  .min(1)
  .max(PASSWORD_MAX_LENGTH * 4);
export const totpCodeSchema = z.string().regex(/^\d{6}$/);
export const opaqueTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,200}$/);
export const totpSecretSchema = z.string().regex(/^[A-Z2-7]{32,64}$/);

export const setupTotpSchema = z.strictObject({
  setupToken: opaqueTokenSchema,
  email: emailSchema,
});

export const setupSchema = z.strictObject({
  setupToken: opaqueTokenSchema,
  instanceName: z.string().trim().min(1).max(80),
  email: emailSchema,
  name: nameSchema,
  password: passwordSchema,
  totpSecret: totpSecretSchema,
  totpCode: totpCodeSchema,
});

export const loginSchema = z.strictObject({ email: emailSchema, password: passwordSchema });

export const secondFactorSchema = z.union([
  z.strictObject({ code: totpCodeSchema }),
  z.strictObject({ recoveryCode: z.string().trim().min(8).max(40) }),
]);

export const totpConfirmSchema = z.strictObject({ code: totpCodeSchema });

export const acceptInviteSchema = z.strictObject({
  token: opaqueTokenSchema,
  password: passwordSchema,
});

export const createUserSchema = z.strictObject({
  email: emailSchema,
  name: nameSchema,
  role: z.enum(ROLES),
});

export const updateUserSchema = z
  .strictObject({
    name: nameSchema.optional(),
    role: z.enum(ROLES).optional(),
    status: z.enum(['active', 'suspended']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update');

export const setCapabilitiesSchema = z.strictObject({
  capabilities: z.array(z.enum(CAPABILITIES)).max(CAPABILITIES.length),
});

export const upsertGrantSchema = z.strictObject({
  userId: idSchema,
  scopeType: z.enum(SCOPE_TYPES),
  scopeId: idSchema,
  level: z.enum(ACCESS_LEVELS),
  itemScope: z.enum(ITEM_SCOPES).optional(),
});

export const deviceDecisionSchema = z.strictObject({
  decision: z.enum(['approve', 'reject', 'revoke']),
});

const titleSchema = z.string().trim().min(1).max(200);

export const createSpaceSchema = z.strictObject({ name: titleSchema });
export const createFolderSchema = z.strictObject({ spaceId: idSchema, name: titleSchema });
const stageNameSchema = z.string().trim().min(1).max(60);
const stageColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform((value) => value.toLowerCase());
const stageKindSchema = z.enum(STAGE_KINDS);

/** A stage as it is described before it exists: also the format of an exported set. */
export const stageDraftSchema = z.strictObject({
  name: stageNameSchema,
  color: stageColorSchema,
  kind: stageKindSchema,
});
const stageSetSchema = z
  .array(stageDraftSchema)
  .min(1)
  .max(MAX_STAGES_PER_LIST)
  .refine(
    (stages) => new Set(stages.map((stage) => stage.name.toLowerCase())).size === stages.length,
    'duplicate stage names',
  );

export const createListSchema = z.strictObject({
  spaceId: idSchema,
  folderId: idSchema.nullable().optional(),
  name: titleSchema,
  isSensitive: z.boolean().optional(),
  /** Omitted: the list starts with the default set. */
  stages: stageSetSchema.optional(),
});
export const createStageSchema = z.strictObject({
  name: stageNameSchema,
  color: stageColorSchema.optional(),
  kind: stageKindSchema.optional(),
});
export const updateStageSchema = z
  .strictObject({
    name: stageNameSchema.optional(),
    color: stageColorSchema.optional(),
    kind: stageKindSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update');
export const reorderStagesSchema = z.strictObject({
  ids: z.array(idSchema).min(1).max(MAX_STAGES_PER_LIST),
});
export const deleteStageSchema = z.strictObject({
  /** Where the items of the removed stage go. Required when it still has items. */
  moveTo: idSchema.optional(),
});

const fieldNameSchema = z.string().trim().min(1).max(60);
const fieldOptionSchema = z.strictObject({
  /** Present for an option that already exists; omitted for a new one. */
  id: idSchema.optional(),
  name: z.string().trim().min(1).max(60),
  color: stageColorSchema.optional(),
  archived: z.boolean().optional(),
});
const fieldConfigSchema = z.strictObject({
  options: z.array(fieldOptionSchema).max(MAX_FIELD_OPTIONS).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  max: z.number().int().min(3).max(10).optional(),
});
export const createFieldSchema = z.strictObject({
  name: fieldNameSchema,
  kind: z.enum(FIELD_KINDS),
  config: fieldConfigSchema.optional(),
});
export const updateFieldSchema = z
  .strictObject({
    name: fieldNameSchema.optional(),
    config: fieldConfigSchema.optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update');
export const reorderFieldsSchema = z.strictObject({
  ids: z.array(idSchema).min(1).max(MAX_FIELDS_PER_LIST),
});
export const copyFieldsSchema = z.strictObject({
  fromListId: idSchema,
  /** Omitted: every field of the other list. */
  fieldIds: z.array(idSchema).min(1).max(MAX_FIELDS_PER_LIST).optional(),
});
export const listFieldsQuerySchema = z.strictObject({
  archived: z.enum(['1']).optional(),
});
/** Only the shape is checked here; whether a value fits its field is `fieldValueProblem`. */
const fieldValueSchema = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.array(idSchema).max(MAX_LABELS_PER_VALUE),
]);
/** Values by field id. `null` clears the field. */
const fieldValuesSchema = z
  .record(idSchema, fieldValueSchema.nullable())
  .refine((values) => Object.keys(values).length <= MAX_FIELDS_PER_LIST, 'too many fields');

export const createItemSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(50_000).optional(),
  stageId: idSchema.optional(),
  fields: fieldValuesSchema.optional(),
});
export const updateItemSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(50_000).optional(),
    stageId: idSchema.optional(),
    fields: fieldValuesSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update');
export const setAssigneesSchema = z.strictObject({ userIds: z.array(idSchema).max(50) });

export const itemHistoryQuerySchema = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditQuerySchema = z.strictObject({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(100).optional(),
  actor: idSchema.optional(),
});
