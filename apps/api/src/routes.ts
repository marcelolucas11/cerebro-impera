import {
  acceptInviteSchema,
  applyStagesSchema,
  attachmentListQuerySchema,
  auditQuerySchema,
  changePasswordSchema,
  copyFieldsSchema,
  createFieldSchema,
  createFolderSchema,
  createItemSchema,
  createListSchema,
  createSpaceSchema,
  createStageSchema,
  createUserSchema,
  deleteStageSchema,
  downloadQuerySchema,
  deviceDecisionSchema,
  idSchema,
  itemHistoryQuerySchema,
  listFieldsQuerySchema,
  loginSchema,
  moveItemSchema,
  reorderFieldsSchema,
  reorderStagesSchema,
  secondFactorSchema,
  setAssigneesSchema,
  setCapabilitiesSchema,
  setupSchema,
  setupTotpSchema,
  startUploadSchema,
  totpConfirmSchema,
  updateFieldSchema,
  updateItemSchema,
  updateStageSchema,
  updateUserSchema,
  upsertGrantSchema,
} from '@cerebro/shared';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withActor, type Actor } from './actor.js';
import { one, sql, type Tx } from './db.js';
import type { Deps } from './deps.js';
import { PREVIEWABLE } from './files/sniff.js';
import { PART_SIZE } from './files/store.js';
import { clearCookie, SESSION_COOKIE } from './http/cookies.js';
import { badRequest } from './http/errors.js';
import { parse } from './http/request.js';
import * as attachments from './modules/attachments.js';
import * as auth from './modules/auth.js';
import * as fields from './modules/fields.js';
import * as grants from './modules/grants.js';
import * as history from './modules/history.js';
import * as oversight from './modules/oversight.js';
import * as people from './modules/people.js';
import * as stages from './modules/stages.js';
import * as structure from './modules/structure.js';

function paramId(request: FastifyRequest): string {
  return parse(idSchema, (request.params as { id?: unknown }).id);
}

export function registerRoutes(app: FastifyInstance, deps: Deps): void {
  /** Runs a handler for the signed-in person, inside their database transaction. */
  const signedIn = <T>(
    request: FastifyRequest,
    handler: (tx: Tx, actor: Actor) => Promise<T>,
  ): Promise<T> => withActor(deps, request, handler);

  app.get('/api/health', async () => {
    await deps.pools.app.query('SELECT 1');
    return { status: 'ok' };
  });

  // ---- First-run setup -----------------------------------------------------
  app.get('/api/setup/status', () => auth.setupStatus(deps));
  app.post('/api/setup/totp', (request) =>
    auth.setupTotp(deps, request, parse(setupTotpSchema, request.body)),
  );
  app.post('/api/setup', (request, reply) =>
    auth.completeSetup(deps, request, reply, parse(setupSchema, request.body)),
  );

  // ---- Sign-in ---------------------------------------------------------------
  app.post('/api/auth/login', (request, reply) =>
    auth.login(deps, request, reply, parse(loginSchema, request.body)),
  );
  app.post('/api/auth/login/verify', (request, reply) =>
    auth.verifySecondFactor(deps, request, reply, parse(secondFactorSchema, request.body)),
  );
  app.post('/api/auth/totp/enroll', (request) => auth.enrollStart(deps, request));
  app.post('/api/auth/totp/confirm', (request, reply) =>
    auth.enrollConfirm(deps, request, reply, parse(totpConfirmSchema, request.body)),
  );
  app.post('/api/auth/invite/accept', (request, reply) =>
    auth.acceptInvite(deps, request, reply, parse(acceptInviteSchema, request.body)),
  );
  app.get('/api/auth/device', (request) => auth.deviceStatus(deps, request));

  app.post('/api/auth/step-up', async (request) => {
    const body = parse(totpConfirmSchema, request.body);
    // The request's own transaction ends before the login service touches the
    // session. Both may write the same session row, and one waiting for the
    // other inside a single request would stall it.
    const actor = await signedIn(request, (_tx, who) => Promise.resolve(who));
    await auth.stepUp(deps, request, actor, body);
    return { ok: true };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    await signedIn(request, (tx, actor) => people.revokeSession(tx, actor.sessionId));
    clearCookie(reply, SESSION_COOKIE);
    return { ok: true };
  });

  // ---- The signed-in person --------------------------------------------------
  app.get('/api/me', (request) =>
    signedIn(request, async (tx, actor) => {
      const settings = await one<{ instance_name: string }>(
        tx,
        sql`SELECT instance_name FROM app.instance_settings`,
      );
      return {
        user: { id: actor.userId, name: actor.name, email: actor.email, role: actor.role },
        capabilities: actor.capabilities,
        stepUp: actor.stepUp,
        instanceName: settings?.instance_name ?? '',
        grants: await grants.listGrants(tx, actor, actor.userId),
      };
    }),
  );
  app.post('/api/me/password', async (request) => {
    const body = parse(changePasswordSchema, request.body);
    // As with step-up: the login service writes sessions, so it runs after the
    // request's own transaction has ended.
    const actor = await signedIn(request, (_tx, who) => Promise.resolve(who));
    return auth.changePassword(deps, request, actor, body);
  });
  app.get('/api/me/sessions', (request) => signedIn(request, (tx) => people.mySessions(tx)));
  app.delete('/api/me/sessions/:id', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx) => people.revokeSession(tx, id));
    return { ok: true };
  });
  app.get('/api/me/devices', (request) => signedIn(request, (tx) => people.listDevices(tx, true)));

  // ---- People ------------------------------------------------------------------
  app.get('/api/users', (request) => signedIn(request, (tx, actor) => people.listUsers(tx, actor)));
  app.post('/api/users', (request) => {
    const body = parse(createUserSchema, request.body);
    return signedIn(request, (tx, actor) => people.createUser(tx, actor, body));
  });
  app.patch('/api/users/:id', (request) => {
    const id = paramId(request);
    const body = parse(updateUserSchema, request.body);
    return signedIn(request, (tx, actor) => people.updateUser(tx, actor, id, body));
  });
  app.put('/api/users/:id/capabilities', (request) => {
    const id = paramId(request);
    const body = parse(setCapabilitiesSchema, request.body);
    return signedIn(request, (tx, actor) =>
      people.setCapabilities(tx, actor, id, body.capabilities),
    );
  });
  app.post('/api/users/:id/invite', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => people.reissueInvite(tx, actor, id));
  });
  app.post('/api/users/:id/revoke-sessions', (request) => {
    const id = paramId(request);
    return signedIn(request, async (tx, actor) => ({
      revoked: await people.revokeUserSessions(tx, actor, id),
    }));
  });
  app.get('/api/users/:id/grants', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => grants.listGrants(tx, actor, id));
  });

  // ---- Devices -----------------------------------------------------------------
  app.get('/api/devices', (request) => signedIn(request, (tx) => people.listDevices(tx, false)));
  app.post('/api/devices/:id/decision', (request) => {
    const id = paramId(request);
    const body = parse(deviceDecisionSchema, request.body);
    return signedIn(request, async (tx, actor) => ({
      status: await people.decideDevice(tx, actor, id, body.decision),
    }));
  });

  // ---- Grants ------------------------------------------------------------------
  app.put('/api/grants', (request) => {
    const body = parse(upsertGrantSchema, request.body);
    return signedIn(request, (tx, actor) => grants.upsertGrant(tx, actor, body));
  });
  app.delete('/api/grants/:id', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx, actor) => grants.deleteGrant(tx, actor, id));
    return { ok: true };
  });

  // ---- Structure and items -------------------------------------------------------
  app.get('/api/tree', (request) => signedIn(request, (tx, actor) => structure.tree(tx, actor)));
  app.post('/api/spaces', (request) => {
    const body = parse(createSpaceSchema, request.body);
    return signedIn(request, (tx, actor) => structure.createSpace(tx, actor, body));
  });
  app.post('/api/folders', (request) => {
    const body = parse(createFolderSchema, request.body);
    return signedIn(request, (tx, actor) => structure.createFolder(tx, actor, body));
  });
  app.post('/api/lists', (request) => {
    const body = parse(createListSchema, request.body);
    return signedIn(request, (tx, actor) => structure.createList(tx, actor, body));
  });
  app.get('/api/lists/:id/items', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => structure.listItems(tx, actor, id));
  });
  app.post('/api/lists/:id/items', (request) => {
    const id = paramId(request);
    const body = parse(createItemSchema, request.body);
    return signedIn(request, (tx, actor) => structure.createItem(tx, actor, id, body));
  });
  app.patch('/api/items/:id', (request) => {
    const id = paramId(request);
    const body = parse(updateItemSchema, request.body);
    return signedIn(request, (tx, actor) => structure.updateItem(tx, actor, id, body));
  });
  app.put('/api/items/:id/assignees', (request) => {
    const id = paramId(request);
    const body = parse(setAssigneesSchema, request.body);
    return signedIn(request, (tx, actor) => structure.setAssignees(tx, actor, id, body.userIds));
  });

  // ---- Stages --------------------------------------------------------------------
  app.get('/api/lists/:id/stages', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => stages.listStages(tx, actor, id));
  });
  app.post('/api/lists/:id/stages', (request) => {
    const id = paramId(request);
    const body = parse(createStageSchema, request.body);
    return signedIn(request, (tx, actor) => stages.createStage(tx, actor, id, body));
  });
  app.post('/api/lists/:id/stages/apply', (request) => {
    const id = paramId(request);
    const body = parse(applyStagesSchema, request.body);
    return signedIn(request, (tx, actor) => stages.applyStages(tx, actor, id, body.stages));
  });
  app.put('/api/lists/:id/stages/order', (request) => {
    const id = paramId(request);
    const body = parse(reorderStagesSchema, request.body);
    return signedIn(request, (tx, actor) => stages.reorderStages(tx, actor, id, body.ids));
  });
  app.patch('/api/stages/:id', (request) => {
    const id = paramId(request);
    const body = parse(updateStageSchema, request.body);
    return signedIn(request, (tx, actor) => stages.updateStage(tx, actor, id, body));
  });
  app.delete('/api/stages/:id', (request) => {
    const id = paramId(request);
    const body = parse(deleteStageSchema, request.body ?? {});
    return signedIn(request, (tx, actor) => stages.deleteStage(tx, actor, id, body));
  });
  app.get('/api/items/:id/stage-history', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => stages.itemStageHistory(tx, actor, id));
  });

  app.get('/api/lists/:id/people', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => structure.listPeople(tx, actor, id));
  });
  app.post('/api/items/:id/move', (request) => {
    const id = paramId(request);
    const body = parse(moveItemSchema, request.body);
    return signedIn(request, (tx, actor) => structure.moveItem(tx, actor, id, body));
  });
  app.post('/api/items/:id/trash', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx, actor) => structure.trashItem(tx, actor, id));
    return { ok: true };
  });
  app.post('/api/items/:id/restore', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => structure.restoreItem(tx, actor, id));
  });
  app.get('/api/lists/:id/trash', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => structure.listTrash(tx, actor, id));
  });
  app.get('/api/items/:id/history', (request) => {
    const id = paramId(request);
    const query = parse(itemHistoryQuerySchema, request.query);
    return signedIn(request, (tx, actor) => history.itemHistory(tx, actor, id, query));
  });

  // ---- Attachments -----------------------------------------------------------------
  app.get('/api/items/:id/attachments', (request) => {
    const id = paramId(request);
    const query = parse(attachmentListQuerySchema, request.query);
    return signedIn(request, (tx, actor) =>
      attachments.listAttachments(tx, actor, id, { inTrash: query.trash === '1' }),
    );
  });
  app.get('/api/lists/:id/attachments/:attachmentId', (request) => {
    const id = paramId(request);
    const attachmentId = parse(
      idSchema,
      (request.params as { attachmentId?: unknown }).attachmentId,
    );
    return signedIn(request, (tx, actor) =>
      attachments.attachmentInList(tx, actor, id, attachmentId),
    );
  });
  app.post('/api/items/:id/attachments', (request) => {
    const id = paramId(request);
    const body = parse(startUploadSchema, request.body);
    return signedIn(request, (tx, actor) => attachments.startUpload(deps, tx, actor, id, body));
  });
  // Parts arrive as raw bytes, up to one part per request, only on this route.
  void app.register((scope, _options, done) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: PART_SIZE },
      (_request, body, parsed) => {
        parsed(null, body);
      },
    );
    scope.put('/api/uploads/:id/parts/:n', { bodyLimit: PART_SIZE }, (request) => {
      const id = paramId(request);
      const n = parse(partNumberSchema, (request.params as { n?: unknown }).n);
      if (!Buffer.isBuffer(request.body)) throw badRequest('expected_bytes');
      const content = request.body;
      return signedIn(request, (tx, actor) =>
        attachments.receivePart(deps, tx, actor, id, n, content),
      );
    });
    done();
  });
  app.get('/api/uploads/:id', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => attachments.uploadState(deps, tx, actor, id));
  });
  app.post('/api/uploads/:id/finish', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) =>
      attachments.finishUpload(deps, tx, actor, id, (error) => {
        request.log.error({ err: error }, 'an attachment could not be checked');
      }),
    );
  });
  app.delete('/api/uploads/:id', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx, actor) => attachments.cancelUpload(tx, actor, id));
    return { ok: true };
  });
  app.post('/api/attachments/:id/trash', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx, actor) => attachments.trashAttachment(tx, actor, id));
    return { ok: true };
  });
  app.post('/api/attachments/:id/restore', (request) => {
    const id = paramId(request);
    return signedIn(request, (tx, actor) => attachments.restoreAttachment(tx, actor, id));
  });
  app.get('/api/attachments/:id/content', async (request, reply) => {
    const id = paramId(request);
    const query = parse(downloadQuerySchema, request.query);
    const range = parseRange(request.headers.range);
    const file = await signedIn(request, (tx, actor) =>
      attachments.download(deps, tx, actor, id, range),
    );
    const inline = query.inline === '1' && file.type !== null && PREVIEWABLE.has(file.type);
    void reply
      .status(range ? 206 : 200)
      .header('content-type', inline && file.type !== null ? file.type : 'application/octet-stream')
      .header('content-disposition', contentDisposition(inline, file.name))
      .header('content-length', String(file.end - file.start + 1))
      .header('accept-ranges', 'bytes')
      // A file is never a page: nothing in it runs, even if a browser tried.
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cache-control', 'no-store');
    if (range) void reply.header('content-range', `bytes ${file.start}-${file.end}/${file.size}`);
    return reply.send(Readable.from(file.chunks));
  });

  // ---- Custom fields -------------------------------------------------------------
  app.get('/api/lists/:id/fields', (request) => {
    const id = paramId(request);
    const query = parse(listFieldsQuerySchema, request.query);
    return signedIn(request, (tx, actor) =>
      fields.listFields(tx, actor, id, { includeArchived: query.archived === '1' }),
    );
  });
  app.post('/api/lists/:id/fields', (request) => {
    const id = paramId(request);
    const body = parse(createFieldSchema, request.body);
    return signedIn(request, (tx, actor) => fields.createField(tx, actor, id, body));
  });
  app.put('/api/lists/:id/fields/order', (request) => {
    const id = paramId(request);
    const body = parse(reorderFieldsSchema, request.body);
    return signedIn(request, (tx, actor) => fields.reorderFields(tx, actor, id, body.ids));
  });
  app.post('/api/lists/:id/fields/copy', (request) => {
    const id = paramId(request);
    const body = parse(copyFieldsSchema, request.body);
    return signedIn(request, (tx, actor) => fields.copyFields(tx, actor, id, body));
  });
  app.patch('/api/fields/:id', (request) => {
    const id = paramId(request);
    const body = parse(updateFieldSchema, request.body);
    return signedIn(request, (tx, actor) => fields.updateField(tx, actor, id, body));
  });

  // ---- Oversight -----------------------------------------------------------------
  app.get('/api/audit', (request) => {
    const query = parse(auditQuerySchema, request.query);
    return signedIn(request, (tx, actor) => oversight.listAudit(tx, actor, query));
  });
  app.get('/api/audit/verify', (request) =>
    signedIn(request, (tx, actor) => oversight.verifyAudit(tx, actor)),
  );
  app.get('/api/alerts', (request) =>
    signedIn(request, (tx, actor) => oversight.listAlerts(tx, actor)),
  );
  app.post('/api/alerts/:id/acknowledge', async (request) => {
    const id = paramId(request);
    await signedIn(request, (tx, actor) => oversight.acknowledgeAlert(tx, actor, id));
    return { ok: true };
  });
}

const partNumberSchema = z.coerce.number().int().min(0).max(200_000);

/** One byte range ("bytes=10-20", "bytes=10-"), or null for anything else. */
function parseRange(header: string | undefined): { start: number; end: number } | null {
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '' ? Number.MAX_SAFE_INTEGER : Number(match[2]);
  return end >= start ? { start, end } : null;
}

/** The file's own name, safe in a header whatever characters it has. */
function contentDisposition(inline: boolean, name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
