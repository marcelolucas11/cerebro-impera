import { z } from 'zod';
import { ACCESS_LEVELS, ITEM_SCOPES, SCOPE_TYPES } from './access.js';
import { CAPABILITIES } from './capabilities.js';
import {
  FIELD_KINDS,
  isRealDate,
  MAX_FIELD_OPTIONS,
  MAX_FIELDS_PER_LIST,
  MAX_LABELS_PER_VALUE,
  MAX_SECRET_LENGTH,
} from './fields.js';
import { MAX_FILE_NAME_LENGTH, safeFileName } from './files.js';
import { PASSWORD_MAX_LENGTH } from './password.js';
import { ROLES } from './roles.js';
import { MAX_STAGES_PER_LIST, STAGE_FILE_KIND, STAGE_FILE_VERSION, STAGE_KINDS } from './stages.js';

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

/** Changing one's own password takes the current one and a fresh code from the authenticator. */
export const changePasswordSchema = z.strictObject({
  currentPassword: passwordSchema,
  newPassword: passwordSchema,
  code: totpCodeSchema,
});

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

/** Stages to bring into a list: missing ones are created, same-named ones take these settings. */
export const applyStagesSchema = z.strictObject({ stages: stageSetSchema });
/** A set of stages saved as a file, to be imported into another list or installation. */
export const stageFileSchema = z.strictObject({
  kind: z.literal(STAGE_FILE_KIND),
  version: z.literal(STAGE_FILE_VERSION),
  name: z.string().trim().min(1).max(120),
  stages: stageSetSchema,
});

export const createListSchema = z.strictObject({
  spaceId: idSchema,
  folderId: idSchema.nullable().optional(),
  name: titleSchema,
  isSensitive: z.boolean().optional(),
  /** Omitted: the list starts with the default set. */
  stages: stageSetSchema.optional(),
});
/** Who may put items into a stage: from this role up; null for anyone who edits the item. */
export const STAGE_ENTRY_ROLES = ['manager', 'admin', 'owner'] as const;
export type StageEntryRole = (typeof STAGE_ENTRY_ROLES)[number];
const stageEntrySchema = z.enum(STAGE_ENTRY_ROLES).nullable();
export const createStageSchema = z.strictObject({
  name: stageNameSchema,
  color: stageColorSchema.optional(),
  kind: stageKindSchema.optional(),
  entryRole: stageEntrySchema.optional(),
});
export const updateStageSchema = z
  .strictObject({
    name: stageNameSchema.optional(),
    color: stageColorSchema.optional(),
    kind: stageKindSchema.optional(),
    entryRole: stageEntrySchema.optional(),
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
  /** Created as a subtask of this item, of the same list. */
  parentId: idSchema.optional(),
});
const commentBody = z
  .string()
  .max(10_000)
  .refine((value) => value.trim() !== '', 'empty comment');
/** People mentioned in one comment, at most. */
export const MAX_MENTIONS_PER_COMMENT = 20;
export const commentSchema = z.strictObject({
  body: commentBody,
  /** People named in the comment; each must be able to see the item. */
  mentions: z
    .array(idSchema)
    .max(MAX_MENTIONS_PER_COMMENT)
    .refine((ids) => new Set(ids).size === ids.length, 'repeated person')
    .optional(),
});

/** Lines in one item's checklist, at most. */
export const MAX_CHECKS_PER_ITEM = 100;
const checkText = z.string().trim().min(1).max(500);
export const addCheckSchema = z.strictObject({ text: checkText });
export const updateCheckSchema = z
  .strictObject({ text: checkText.optional(), done: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0, 'empty update');

/** Marks notifications as read: the ones given, or all of them. */
export const readNotificationsSchema = z.strictObject({
  ids: z.array(z.number().int().positive()).min(1).max(200).optional(),
});
export const notificationsQuerySchema = z.strictObject({
  antes: z.coerce.number().int().positive().optional(),
});

/** How often an item comes back once finished. */
export const RECURRENCE_UNITS = ['day', 'week', 'month', 'year'] as const;
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];
export const recurrenceSchema = z.strictObject({
  unit: z.enum(RECURRENCE_UNITS),
  every: z.number().int().min(1).max(99),
});

/** Priority of an item: 1 is the most urgent, 4 the least. */
export const PRIORITIES = [1, 2, 3, 4] as const;
export type Priority = (typeof PRIORITIES)[number];
/** A day, as YYYY-MM-DD, that exists. */
export const daySchema = z.string().refine(isRealDate, 'not a day');
export const updateItemSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(50_000).optional(),
    stageId: idSchema.optional(),
    fields: fieldValuesSchema.optional(),
    priority: z.number().int().min(1).max(4).nullable().optional(),
    startDate: daySchema.nullable().optional(),
    dueDate: daySchema.nullable().optional(),
    /** Only to take a subtask out from under its parent. */
    parentId: z.null().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update')
  .refine(
    (value) =>
      typeof value.startDate !== 'string' ||
      typeof value.dueDate !== 'string' ||
      value.startDate <= value.dueDate,
    'start after due',
  );
const selection = z
  .array(idSchema)
  .min(1)
  .max(200)
  .refine((ids) => new Set(ids).size === ids.length, 'repeated item');
/** One change to several items of a list at once. */
export const bulkSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('stage'), ids: selection, stageId: idSchema }),
  z.strictObject({ action: z.literal('trash'), ids: selection }),
  z.strictObject({ action: z.literal('assign'), ids: selection, userId: idSchema }),
]);

/** The order of items in one stage, as the board shows it, top first. */
export const orderItemsSchema = z.strictObject({
  stageId: idSchema,
  ids: z
    .array(idSchema)
    .min(1)
    .max(500)
    .refine((ids) => new Set(ids).size === ids.length, 'repeated item'),
});

/** The query part of an address as the page writes it ("?busca=…"), or nothing. */
export const VIEW_QUERY_PATTERN = /^(\?[A-Za-z0-9%._~:=&+-]*)?$/;
export const MAX_VIEWS_PER_LIST = 30;
export const VIEW_KINDS = ['list', 'board', 'calendar', 'table', 'timeline'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];
const viewName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  // Control characters are exactly what this refuses.
  // eslint-disable-next-line no-control-regex
  .refine((name) => !/[\u0000-\u001f\u007f]/.test(name), 'invalid name');
const viewQuery = z.string().max(2000).regex(VIEW_QUERY_PATTERN);
export const createViewSchema = z.strictObject({
  name: viewName,
  kind: z.enum(VIEW_KINDS),
  query: viewQuery,
});
export const updateViewSchema = z
  .strictObject({
    name: viewName.optional(),
    kind: z.enum(VIEW_KINDS).optional(),
    query: viewQuery.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'empty update');

/** A secret as typed, or null to clear it. Never trimmed. */
export const setSecretSchema = z.strictObject({
  value: z.string().min(1).max(MAX_SECRET_LENGTH).nullable(),
});

export const startUploadSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FILE_NAME_LENGTH)
    .refine((name) => safeFileName(name) === name, 'invalid file name'),
  size: z.number().int().min(1).max(1_099_511_627_776),
  type: z.string().max(200),
});
export const attachmentListQuerySchema = z.strictObject({ trash: z.enum(['1']).optional() });
export const downloadQuerySchema = z.strictObject({ inline: z.enum(['1']).optional() });

export const moveItemSchema = z.strictObject({
  listId: idSchema,
  /** Omitted: the first stage of the list it goes to. */
  stageId: idSchema.optional(),
});
export const setAssigneesSchema = z.strictObject({ userIds: z.array(idSchema).max(50) });

/** Words to look for in every list the person can open. */
export const searchQuerySchema = z.strictObject({ q: z.string().trim().min(2).max(100) });

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

/*
 * Automations: when (item created, item enters a stage), if (conditions, all
 * of which must hold), then (actions, in order). The database checks every id
 * against the rule's own list.
 */
export const MAX_AUTOMATIONS_PER_LIST = 50;
export const MAX_AUTOMATION_CONDITIONS = 10;
export const MAX_AUTOMATION_ACTIONS = 5;
export const MAX_AUTOMATION_NOTIFY = 10;
export const MAX_AUTOMATION_COMMENT = 2000;
export const MAX_AUTOMATION_DUE_DAYS = 365;
export const MAX_AUTOMATION_DUE_OFFSET = 30;
const priorityOrNone = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable();

/** An option of a choice field, or a checkbox ticked or not. */
const choiceSchema = z.union([z.string().min(1).max(100), z.boolean()]);
export const automationTriggerSchema = z.discriminatedUnion('on', [
  z.strictObject({ on: z.literal('created') }),
  z.strictObject({ on: z.literal('stage'), to: idSchema.optional(), from: idSchema.optional() }),
  /** A field changes: to anything, or (choice and checkbox) to one value. */
  z.strictObject({ on: z.literal('field'), field: idSchema, is: choiceSchema.optional() }),
  /** Someone is handed the item: anyone, or one person. */
  z.strictObject({ on: z.literal('assigned'), to: idSchema.optional() }),
  /** The due date comes: days before it (negative), on the day (0) or days late. */
  z.strictObject({
    on: z.literal('due'),
    offset: z.number().int().min(-MAX_AUTOMATION_DUE_OFFSET).max(MAX_AUTOMATION_DUE_OFFSET),
  }),
]);
export const automationConditionSchema = z.discriminatedUnion('if', [
  z.strictObject({ if: z.literal('stage'), is: idSchema }),
  z.strictObject({ if: z.literal('priority'), is: priorityOrNone }),
  z.strictObject({ if: z.literal('assignee'), is: idSchema.nullable() }),
  /** A choice field (the option's id) or a checkbox (ticked or not). */
  z.strictObject({ if: z.literal('field'), field: idSchema, is: choiceSchema }),
]);
export const automationActionSchema = z.discriminatedUnion('do', [
  z.strictObject({ do: z.literal('stage'), to: idSchema }),
  z.strictObject({ do: z.literal('priority'), to: priorityOrNone }),
  z.strictObject({ do: z.literal('assign'), to: idSchema }),
  z.strictObject({
    do: z.literal('notify'),
    to: z
      .array(idSchema)
      .min(1)
      .max(MAX_AUTOMATION_NOTIFY)
      .refine((ids) => new Set(ids).size === ids.length, 'repeated person'),
  }),
  z.strictObject({
    do: z.literal('comment'),
    text: z.string().trim().min(1).max(MAX_AUTOMATION_COMMENT),
  }),
  /** Fills in a field (checked against its kind by the database), or clears it with null. */
  z.strictObject({ do: z.literal('field'), field: idSchema, value: fieldValueSchema.nullable() }),
  /** The due date that many days from the day the rule acts; null clears it. */
  z.strictObject({
    do: z.literal('due'),
    in: z.number().int().min(0).max(MAX_AUTOMATION_DUE_DAYS).nullable(),
  }),
  z.strictObject({ do: z.literal('subtask'), title: titleSchema }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type AutomationAction = z.infer<typeof automationActionSchema>;

const automationName = z.string().trim().min(1).max(80);
export const automationSchema = z.strictObject({
  name: automationName,
  enabled: z.boolean().optional(),
  trigger: automationTriggerSchema,
  conditions: z.array(automationConditionSchema).max(MAX_AUTOMATION_CONDITIONS).default([]),
  actions: z.array(automationActionSchema).min(1).max(MAX_AUTOMATION_ACTIONS),
});
/** Any part of a rule; saving it makes the rule act as whoever saved it. */
export const updateAutomationSchema = z
  .strictObject({
    name: automationName,
    enabled: z.boolean(),
    trigger: automationTriggerSchema,
    conditions: z.array(automationConditionSchema).max(MAX_AUTOMATION_CONDITIONS),
    actions: z.array(automationActionSchema).min(1).max(MAX_AUTOMATION_ACTIONS),
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'nothing to change');
