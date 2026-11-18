import type { FieldConfig, FieldKind, FieldValue } from '@cerebro/shared';

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
  spaces: { id: string; name: string }[];
  folders: { id: string; spaceId: string; name: string }[];
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
export interface Stage {
  id: string;
  listId: string;
  name: string;
  color: string;
  kind: StageKind;
  position: number;
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
    | 'attachment_restored';
  fieldId: string | null;
  old: unknown;
  new: unknown;
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
  updateStage: (id: string, input: { name?: string; color?: string; kind?: StageKind }) =>
    request<Stage>('PATCH', `/api/stages/${id}`, input),
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
  createItem: (listId: string, input: { title: string; stageId?: string }) =>
    request<Item>('POST', `/api/lists/${listId}/items`, input),
  updateItem: (
    id: string,
    input: {
      title?: string;
      description?: string;
      stageId?: string;
      /** `null` clears a field. */
      fields?: Record<string, FieldValue | null>;
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
