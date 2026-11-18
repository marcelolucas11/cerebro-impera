import type { FieldConfig, FieldKind, FieldValue } from '@cerebro/shared';
import type { ListView } from './router.js';

/** A refusal from the server, or `network` when it could not be reached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, details: Record<string, unknown> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/*
 * Every call goes to this page's own origin. The session lives in an HttpOnly
 * cookie the script cannot read, so there is no token to keep (or leak) here.
 */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  return call<T>(
    method,
    path,
    method === 'GET' ? null : { type: 'application/json', content: JSON.stringify(body ?? {}) },
  );
}

/** A request whose body is raw bytes: a part of a file being sent. */
async function sendBytes<T>(method: Method, path: string, content: Blob): Promise<T> {
  return call<T>(method, path, { type: 'application/octet-stream', content });
}

async function call<T>(
  method: Method,
  path: string,
  body: { type: string; content: string | Blob } | null,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers:
        body === null
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': body.type },
      ...(body === null ? {} : { body: body.content }),
    });
  } catch {
    throw new ApiError(0, 'network');
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = text === '' ? undefined : JSON.parse(text);
  } catch {
    data = undefined;
  }
  if (!response.ok) {
    const error = isRecord(data) && isRecord(data.error) ? data.error : {};
    throw new ApiError(
      response.status,
      typeof error.code === 'string' ? error.code : 'unknown',
      isRecord(error.details) ? error.details : {},
    );
  }
  return data as T;
}

export type Role = 'employee' | 'manager' | 'admin' | 'owner';

export interface SetupStatus {
  needsSetup: boolean;
  instanceName: string;
}
export interface Enrollment {
  secret: string;
  otpauthUri: string;
}
export type SignInResult = { status: 'authenticated' } | { status: 'device_pending' };
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked' | 'unknown';

export interface Me {
  user: { id: string; name: string; email: string; role: Role };
  capabilities: string[];
  stepUp: boolean;
  instanceName: string;
}

export interface Tree {
  /** `canManage`: this person may create folders and lists there. */
  spaces: { id: string; name: string; canManage: boolean }[];
  folders: { id: string; spaceId: string; name: string; canManage: boolean }[];
  lists: {
    id: string;
    spaceId: string;
    folderId: string | null;
    name: string;
    isSensitive: boolean;
    level: 'view' | 'comment' | 'edit' | 'manage';
    itemScope: 'assigned' | 'all';
  }[];
}

export type UserStatus = 'invited' | 'active' | 'suspended';
export type AccessLevel = 'none' | 'view' | 'comment' | 'edit' | 'manage';
export type ItemScope = 'assigned' | 'all';
export type ScopeType = 'space' | 'folder' | 'list';

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  capabilities: string[];
}
export interface InviteLink {
  token: string;
  kind: 'invite' | 'reset';
  expiresAt: string;
}
export interface Grant {
  id: string;
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  level: AccessLevel;
  itemScope: ItemScope;
  grantedBy: string;
  updatedAt: string;
}
export interface Device {
  id: string;
  userId: string;
  userName: string;
  userEmail: string;
  userRole: Role;
  status: Exclude<DeviceStatus, 'unknown'>;
  userAgent: string;
  createdAt: string;
  createdIp: string | null;
  lastSeenAt: string | null;
}
export interface Alert {
  id: string;
  at: string;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  actorUserId: string | null;
  acknowledgedAt: string | null;
}
export interface AuditEntry {
  seq: number;
  at: string;
  actorUserId: string | null;
  ip: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
}
export type StageKind = 'open' | 'active' | 'done' | 'closed';
export type StageEntryRole = 'manager' | 'admin' | 'owner';
export interface Stage {
  id: string;
  listId: string;
  name: string;
  color: string;
  kind: StageKind;
  position: number;
  /** Only people from this role up put items into the stage; null for anyone who edits them. */
  entryRole: StageEntryRole | null;
}
export interface Item {
  id: string;
  listId: string;
  title: string;
  description: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  assignees: string[];
  stageId: string;
  stageSince: string;
  /** Values of the list's custom fields, by field id. A field with no value is absent. */
  fields: Record<string, FieldValue>;
  /** Secret fields that hold a value. The values come only through revealSecret. */
  secrets: string[];
  /** Place in its stage's column on the board; null when never placed. */
  position: number | null;
  /** 1 (most urgent) to 4; null when not set. */
  priority: number | null;
  /** Days, as YYYY-MM-DD; null when not set. */
  startDate: string | null;
  dueDate: string | null;
  /** The item this one is a subtask of; null for an item of its own. */
  parentId: string | null;
  /** How far its checklist is. */
  checks: { done: number; total: number };
  /** Comments on it that were not removed. */
  comments: number;
  /** How often it comes back once finished; null when it does not. */
  recurrence: Recurrence | null;
  /** Set only for an item in the trash. */
  trashedAt: string | null;
  trashedBy: string | null;
}
export interface CustomField {
  id: string;
  listId: string;
  originId: string;
  name: string;
  kind: FieldKind;
  config: FieldConfig;
  position: number;
  archived: boolean;
}
/** An option as it is sent: existing ones carry their id, new ones do not. */
export interface OptionDraft {
  id?: string;
  name: string;
  color?: string;
  archived?: boolean;
}
export interface FieldConfigDraft {
  options?: OptionDraft[];
  currency?: string;
  max?: number;
}
export interface ItemChange {
  id: number;
  at: string;
  /** Null when the change was not made by a signed-in person. */
  actor: string | null;
  what:
    | 'created'
    | 'title'
    | 'description'
    | 'list'
    | 'stage'
    | 'assigned'
    | 'unassigned'
    | 'field'
    | 'trashed'
    | 'restored'
    | 'attachment_added'
    | 'attachment_removed'
    | 'attachment_restored'
    | 'priority'
    | 'start_date'
    | 'due_date'
    | 'parent'
    | 'check_added'
    | 'check_done'
    | 'check_undone'
    | 'check_renamed'
    | 'check_removed'
    | 'recurrence'
    | 'repeated';
  fieldId: string | null;
  old: unknown;
  new: unknown;
  /** Set when a rule made the change, on behalf of `actor`; the name is gone with the rule. */
  automation: RuleMark | null;
}
/** Which rule did something; its name is gone once the rule is removed. */
export interface RuleMark {
  id: string;
  name: string | null;
}
/** Every so many days, weeks, months or years. */
export interface Recurrence {
  unit: 'day' | 'week' | 'month' | 'year';
  every: number;
}
/** Something that happened that this person should know of. */
export interface AppNotification {
  id: number;
  kind: 'mentioned' | 'assigned' | 'commented' | 'due_today' | 'overdue' | 'automation';
  itemId: string;
  itemTitle: string;
  listId: string;
  commentId: string | null;
  actorId: string | null;
  actorName: string | null;
  dueOn: string | null;
  createdAt: string;
  readAt: string | null;
  /** Set when a rule caused it, acting as `actorId`. */
  automation: RuleMark | null;
}
/** A comment on an item, with what the person may do with it. */
export interface ItemComment {
  id: string;
  itemId: string;
  authorId: string;
  /** Empty once removed. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  removedAt: string | null;
  removedBy: string | null;
  versions: number;
  /** People mentioned in it; empty once removed. */
  mentions: string[];
  /** Set when a rule wrote it, as `authorId`; nobody rewrites it. */
  automation: RuleMark | null;
  canEdit: boolean;
  canRemove: boolean;
}
/** Someone who sees an item, or took part in its comments. */
export interface ItemPerson {
  id: string;
  name: string;
  /** Can see the item now, so can be mentioned on it. */
  seesItem: boolean;
}
/** One line of an item's checklist. */
export interface CheckLine {
  id: string;
  itemId: string;
  text: string;
  done: boolean;
  doneBy: string | null;
  doneAt: string | null;
  createdBy: string;
  createdAt: string;
}
/** A rule of a list: when, if, then. */
export type RuleTrigger =
  | { on: 'created' }
  | { on: 'stage'; to?: string; from?: string }
  | { on: 'field'; field: string; is?: string | boolean }
  | { on: 'assigned'; to?: string }
  | { on: 'due'; offset: number };
export type RuleCondition =
  | { if: 'stage'; is: string }
  | { if: 'priority'; is: 1 | 2 | 3 | 4 | null }
  | { if: 'assignee'; is: string | null }
  | { if: 'field'; field: string; is: string | boolean };
export type RuleAction =
  | { do: 'stage'; to: string }
  | { do: 'priority'; to: 1 | 2 | 3 | 4 | null }
  | { do: 'assign'; to: string }
  | { do: 'notify'; to: string[] }
  | { do: 'comment'; text: string }
  | { do: 'field'; field: string; value: FieldValue | null }
  | { do: 'due'; in: number | null }
  | { do: 'subtask'; title: string };
export type RunOutcome = 'done' | 'skipped' | 'failed';
export interface Automation {
  id: string;
  listId: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  /** Whose access it acts with: whoever saved it last. */
  runAs: string;
  runAsName: string;
  createdAt: string;
  updatedAt: string;
  lastRun: { at: string; outcome: RunOutcome } | null;
}
export interface AutomationInput {
  name: string;
  enabled?: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
}
export interface AutomationRun {
  id: number;
  at: string;
  outcome: RunOutcome;
  detail: string | null;
  itemId: string | null;
  itemTitle: string | null;
}
/** Someone a rule may tell; `canWork` also lets a rule hand them items. */
export interface RuleAudience {
  id: string;
  name: string;
  canWork: boolean;
}
export interface MySession {
  id: string;
  deviceId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string;
  current: boolean;
}
export interface StageStay {
  stageId: string;
  stageName: string;
  enteredAt: string;
  leftAt: string | null;
  movedBy: string | null;
}

/** A person's named way of looking at a list. `query` is the address's query part. */
export interface SavedView {
  id: string;
  listId: string;
  name: string;
  kind: ListView;
  query: string;
  updatedAt: string;
}

/** An item found by the global search, in a list the person can open. */
export interface SearchHit {
  id: string;
  title: string;
  listId: string;
  listName: string;
  stageName: string;
  inTitle: boolean;
  updatedAt: string;
}

export type AttachmentStatus = 'uploading' | 'scanning' | 'ready' | 'blocked';
export interface Attachment {
  id: string;
  itemId: string;
  name: string;
  size: number;
  /** What the content is, read from it by the server; null when it is none of the known types. */
  type: string | null;
  status: AttachmentStatus;
  /** False when the installation runs without an antivirus. */
  scanned: boolean;
  createdBy: string;
  createdAt: string;
  trashedAt: string | null;
}
/** Where an upload stands; `received` are the parts already on the server. */
export interface UploadState {
  partSize: number;
  parts: number;
  received: number[];
}

export interface GrantInput {
  userId: string;
  scopeType: ScopeType;
  scopeId: string;
  level: AccessLevel;
  itemScope?: ItemScope;
}

export interface SetupInput {
  setupToken: string;
  instanceName: string;
  email: string;
  name: string;
  password: string;
  totpSecret: string;
  totpCode: string;
}

export const api = {
  setupStatus: () => request<SetupStatus>('GET', '/api/setup/status'),
  setupTotp: (input: { setupToken: string; email: string }) =>
    request<Enrollment>('POST', '/api/setup/totp', input),
  completeSetup: (input: SetupInput) =>
    request<{ recoveryCodes: string[] }>('POST', '/api/setup', input),

  signIn: (input: { email: string; password: string }) =>
    request<{ next: 'totp' | 'enroll_totp' }>('POST', '/api/auth/login', input),
  verify: (input: { code: string } | { recoveryCode: string }) =>
    request<SignInResult>('POST', '/api/auth/login/verify', input),
  enrollStart: () => request<Enrollment>('POST', '/api/auth/totp/enroll'),
  enrollConfirm: (code: string) =>
    request<SignInResult & { recoveryCodes: string[] }>('POST', '/api/auth/totp/confirm', { code }),
  acceptInvite: (input: { token: string; password: string }) =>
    request<{ next: 'enroll_totp' }>('POST', '/api/auth/invite/accept', input),
  deviceStatus: () => request<{ status: DeviceStatus }>('GET', '/api/auth/device'),
  signOut: () => request<{ ok: true }>('POST', '/api/auth/logout'),

  me: () => request<Me>('GET', '/api/me'),
  tree: () => request<Tree>('GET', '/api/tree'),
  stepUp: (code: string) => request<unknown>('POST', '/api/auth/step-up', { code }),

  users: () => request<User[]>('GET', '/api/users'),
  createUser: (input: { email: string; name: string; role: Role }) =>
    request<{ user: User; invite: InviteLink }>('POST', '/api/users', input),
  updateUser: (id: string, input: { role?: Role; status?: 'active' | 'suspended' }) =>
    request<unknown>('PATCH', `/api/users/${id}`, input),
  setCapabilities: (id: string, capabilities: string[]) =>
    request<unknown>('PUT', `/api/users/${id}/capabilities`, { capabilities }),
  newAccessLink: (id: string) => request<InviteLink>('POST', `/api/users/${id}/invite`),
  revokeSessions: (id: string) => request<unknown>('POST', `/api/users/${id}/revoke-sessions`),
  userGrants: (id: string) => request<Grant[]>('GET', `/api/users/${id}/grants`),
  putGrant: (input: GrantInput) => request<Grant>('PUT', '/api/grants', input),
  deleteGrant: (id: string) => request<unknown>('DELETE', `/api/grants/${id}`),

  devices: () => request<Device[]>('GET', '/api/devices'),
  decideDevice: (id: string, decision: 'approve' | 'reject' | 'revoke') =>
    request<unknown>('POST', `/api/devices/${id}/decision`, { decision }),

  alerts: () => request<Alert[]>('GET', '/api/alerts'),
  acknowledgeAlert: (id: string) => request<unknown>('POST', `/api/alerts/${id}/acknowledge`),
  audit: (before?: number) =>
    request<AuditEntry[]>(
      'GET',
      `/api/audit?limit=50${before === undefined ? '' : `&before=${before}`}`,
    ),
  verifyAudit: () =>
    request<{ ok: boolean; checked: number; brokenSeq: number | null }>('GET', '/api/audit/verify'),

  stages: (listId: string) => request<Stage[]>('GET', `/api/lists/${listId}/stages`),
  createStage: (listId: string, input: { name: string; color: string; kind: StageKind }) =>
    request<Stage>('POST', `/api/lists/${listId}/stages`, input),
  updateStage: (
    id: string,
    input: { name?: string; color?: string; kind?: StageKind; entryRole?: StageEntryRole | null },
  ) => request<Stage>('PATCH', `/api/stages/${id}`, input),
  applyStages: (listId: string, stages: { name: string; color: string; kind: StageKind }[]) =>
    request<Stage[]>('POST', `/api/lists/${listId}/stages/apply`, { stages }),
  reorderStages: (listId: string, ids: string[]) =>
    request<Stage[]>('PUT', `/api/lists/${listId}/stages/order`, { ids }),
  deleteStage: (id: string, moveTo?: string) =>
    request<{ moved: number }>(
      'DELETE',
      `/api/stages/${id}`,
      moveTo === undefined ? {} : { moveTo },
    ),

  items: (listId: string) => request<Item[]>('GET', `/api/lists/${listId}/items`),
  comments: (itemId: string) => request<ItemComment[]>('GET', `/api/items/${itemId}/comments`),
  addComment: (itemId: string, body: string, mentions: string[] = []) =>
    request<ItemComment>('POST', `/api/items/${itemId}/comments`, { body, mentions }),
  itemPeople: (itemId: string) => request<ItemPerson[]>('GET', `/api/items/${itemId}/people`),
  editComment: (commentId: string, body: string) =>
    request<ItemComment>('PATCH', `/api/comments/${commentId}`, { body }),
  removeComment: (commentId: string) =>
    request<ItemComment>('DELETE', `/api/comments/${commentId}`),
  commentVersions: (commentId: string) =>
    request<{ body: string; replacedAt: string }[]>('GET', `/api/comments/${commentId}/versions`),
  notifications: (before?: number) =>
    request<AppNotification[]>(
      'GET',
      `/api/notifications${before === undefined ? '' : `?antes=${String(before)}`}`,
    ),
  unreadNotifications: () => request<{ unread: number }>('GET', '/api/notifications/unread'),
  readNotifications: (ids?: number[]) =>
    request<{ read: number }>('POST', '/api/notifications/read', ids === undefined ? {} : { ids }),
  setRecurrence: (itemId: string, rule: Recurrence) =>
    request<Item>('PUT', `/api/items/${itemId}/recurrence`, rule),
  clearRecurrence: (itemId: string) => request<Item>('DELETE', `/api/items/${itemId}/recurrence`),
  checklist: (itemId: string) => request<CheckLine[]>('GET', `/api/items/${itemId}/checklist`),
  addCheck: (itemId: string, text: string) =>
    request<CheckLine>('POST', `/api/items/${itemId}/checklist`, { text }),
  updateCheck: (checkId: string, input: { text?: string; done?: boolean }) =>
    request<CheckLine>('PATCH', `/api/checklist/${checkId}`, input),
  removeCheck: (checkId: string) => request<{ ok: true }>('DELETE', `/api/checklist/${checkId}`),
  automations: (listId: string) => request<Automation[]>('GET', `/api/lists/${listId}/automations`),
  ruleAudience: (listId: string) =>
    request<RuleAudience[]>('GET', `/api/lists/${listId}/automation-audience`),
  createAutomation: (listId: string, input: AutomationInput) =>
    request<Automation>('POST', `/api/lists/${listId}/automations`, input),
  updateAutomation: (id: string, input: Partial<AutomationInput>) =>
    request<Automation>('PATCH', `/api/automations/${id}`, input),
  removeAutomation: (id: string) => request<{ ok: true }>('DELETE', `/api/automations/${id}`),
  automationRuns: (id: string) => request<AutomationRun[]>('GET', `/api/automations/${id}/runs`),
  createItem: (listId: string, input: { title: string; stageId?: string; parentId?: string }) =>
    request<Item>('POST', `/api/lists/${listId}/items`, input),
  updateItem: (
    id: string,
    input: {
      title?: string;
      description?: string;
      stageId?: string;
      /** `null` clears a field. */
      fields?: Record<string, FieldValue | null>;
      /** `null` clears each of these. */
      priority?: number | null;
      startDate?: string | null;
      dueDate?: string | null;
      /** Takes a subtask out from under its parent. */
      parentId?: null;
    },
  ) => request<Item>('PATCH', `/api/items/${id}`, input),
  fields: (listId: string, options: { archived?: boolean } = {}) =>
    request<CustomField[]>(
      'GET',
      `/api/lists/${listId}/fields${options.archived === true ? '?archived=1' : ''}`,
    ),
  createField: (
    listId: string,
    input: { name: string; kind: FieldKind; config?: FieldConfigDraft },
  ) => request<CustomField>('POST', `/api/lists/${listId}/fields`, input),
  updateField: (
    id: string,
    input: { name?: string; config?: FieldConfigDraft; archived?: boolean },
  ) => request<CustomField>('PATCH', `/api/fields/${id}`, input),
  reorderFields: (listId: string, ids: string[]) =>
    request<CustomField[]>('PUT', `/api/lists/${listId}/fields/order`, { ids }),
  copyFields: (listId: string, fromListId: string) =>
    request<{ created: CustomField[]; skipped: string[] }>(
      'POST',
      `/api/lists/${listId}/fields/copy`,
      { fromListId },
    ),
  stageHistory: (itemId: string) =>
    request<StageStay[]>('GET', `/api/items/${itemId}/stage-history`),
  setAssignees: (id: string, userIds: string[]) =>
    request<Item>('PUT', `/api/items/${id}/assignees`, { userIds }),
  /** Who work in this list can be handed to; only for whoever hands it out. */
  listPeople: (listId: string) =>
    request<{ id: string; name: string }[]>('GET', `/api/lists/${listId}/people`),
  mySessions: () => request<MySession[]>('GET', '/api/me/sessions'),
  endSession: (id: string) => request<{ ok: true }>('DELETE', `/api/me/sessions/${id}`),
  changePassword: (input: { currentPassword: string; newPassword: string; code: string }) =>
    request<{ endedSessions: number }>('POST', '/api/me/password', input),
  moveItem: (id: string, input: { listId: string; stageId?: string }) =>
    request<Item>('POST', `/api/items/${id}/move`, input),
  trashItem: (id: string) => request<{ ok: true }>('POST', `/api/items/${id}/trash`),
  restoreItem: (id: string) => request<Item>('POST', `/api/items/${id}/restore`),
  trash: (listId: string) => request<Item[]>('GET', `/api/lists/${listId}/trash`),
  /** Newest first, fifty at a time. `before` continues from the last line of the previous page. */
  itemHistory: (itemId: string, before?: number) =>
    request<ItemChange[]>(
      'GET',
      `/api/items/${itemId}/history${before === undefined ? '' : `?before=${before}`}`,
    ),

  /** One change to several items of a list at once, all or nothing. */
  bulk: (
    listId: string,
    input:
      | { action: 'stage'; ids: string[]; stageId: string }
      | { action: 'trash'; ids: string[] }
      | { action: 'assign'; ids: string[]; userId: string },
  ) => request<{ changed: number }>('POST', `/api/lists/${listId}/bulk`, input),
  /** Puts the items of one stage in this order, top first. All or nothing. */
  orderStage: (listId: string, stageId: string, ids: string[]) =>
    request<{ ok: true }>('PUT', `/api/lists/${listId}/order`, { stageId, ids }),
  search: (q: string) => request<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  views: (listId: string) => request<SavedView[]>('GET', `/api/lists/${listId}/views`),
  createView: (listId: string, input: { name: string; kind: ListView; query: string }) =>
    request<SavedView>('POST', `/api/lists/${listId}/views`, input),
  deleteView: (id: string) => request<{ ok: true }>('DELETE', `/api/views/${id}`),
  /** Keeps a secret, or clears it with null. */
  setSecret: (itemId: string, fieldId: string, value: string | null) =>
    request<{ set: boolean }>('PUT', `/api/items/${itemId}/secrets/${fieldId}`, { value }),
  /** Asks for the authenticator code when it is not recent; every reveal is on the record. */
  revealSecret: (itemId: string, fieldId: string) =>
    request<{ value: string }>('POST', `/api/items/${itemId}/secrets/${fieldId}/reveal`),
  attachments: (itemId: string, options: { trash?: boolean } = {}) =>
    request<Attachment[]>(
      'GET',
      `/api/items/${itemId}/attachments${options.trash === true ? '?trash=1' : ''}`,
    ),
  /** Asked through the list, so a sensitive list asks for the code instead of saying "not found". */
  attachmentInList: (listId: string, id: string) =>
    request<Attachment>('GET', `/api/lists/${listId}/attachments/${id}`),
  startUpload: (itemId: string, input: { name: string; size: number; type: string }) =>
    request<{ id: string; partSize: number; parts: number }>(
      'POST',
      `/api/items/${itemId}/attachments`,
      input,
    ),
  uploadState: (id: string) => request<UploadState>('GET', `/api/uploads/${id}`),
  sendPart: (id: string, n: number, part: Blob) =>
    sendBytes<UploadState>('PUT', `/api/uploads/${id}/parts/${n}`, part),
  finishUpload: (id: string) => request<Attachment>('POST', `/api/uploads/${id}/finish`),
  cancelUpload: (id: string) => request<{ ok: true }>('DELETE', `/api/uploads/${id}`),
  trashAttachment: (id: string) => request<{ ok: true }>('POST', `/api/attachments/${id}/trash`),
  restoreAttachment: (id: string) => request<Attachment>('POST', `/api/attachments/${id}/restore`),
  /** Where the content is read from. Same origin, with the session cookie; never a public link. */
  attachmentUrl: (id: string, options: { inline?: boolean } = {}) =>
    `/api/attachments/${id}/content${options.inline === true ? '?inline=1' : ''}`,

  createSpace: (name: string) => request<{ id: string }>('POST', '/api/spaces', { name }),
  createFolder: (input: { spaceId: string; name: string }) =>
    request<{ id: string }>('POST', '/api/folders', input),
  createList: (input: {
    spaceId: string;
    folderId: string | null;
    name: string;
    isSensitive: boolean;
  }) => request<{ id: string }>('POST', '/api/lists', input),
};
