import {
  acceptInviteSchema,
  auditQuerySchema,
  createFolderSchema,
  createItemSchema,
  createListSchema,
  createSpaceSchema,
  createStageSchema,
  createUserSchema,
  deleteStageSchema,
  deviceDecisionSchema,
  idSchema,
  loginSchema,
  reorderStagesSchema,
  secondFactorSchema,
  setAssigneesSchema,
  setCapabilitiesSchema,
  setupSchema,
  setupTotpSchema,
  totpConfirmSchema,
  updateItemSchema,
  updateStageSchema,
  updateUserSchema,
  upsertGrantSchema,
} from '@cerebro/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { withActor, type Actor } from './actor.js';
import { one, sql, type Tx } from './db.js';
import type { Deps } from './deps.js';
import { clearCookie, SESSION_COOKIE } from './http/cookies.js';
import { parse } from './http/request.js';
import * as auth from './modules/auth.js';
import * as grants from './modules/grants.js';
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
    await signedIn(request, (_tx, actor) => auth.stepUp(deps, request, actor, body));
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
