import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Browser,
  codeFor,
  createTestEnv,
  expireStepUp,
  type Person,
  type TestEnv,
} from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Who can see and do what, exercised through the API exactly as a browser
 * would. The same rules are attacked again in database.test.ts, straight at
 * the database, without any of this code in the way.
 */

interface ErrorBody {
  error: { code: string };
}
interface Item {
  id: string;
  title: string;
  description: string;
  createdBy: string;
  assignees: string[];
}
interface Tree {
  spaces: { id: string }[];
  folders: { id: string }[];
  lists: { id: string; level: string; itemScope: string }[];
}
interface Grant {
  id: string;
  level: string;
  itemScope: string;
}

let env: TestEnv;
let s: Scenario;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
});
afterAll(async () => {
  await env.close();
});

const ids = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id).sort();

async function itemsOf(person: Person, list: string): Promise<Item[]> {
  const response = await person.browser.get<Item[]>(`/api/lists/${list}/items`);
  expect(response.status).toBe(200);
  return response.body;
}

async function treeOf(person: Person): Promise<Tree> {
  const response = await person.browser.get<Tree>('/api/tree');
  expect(response.status).toBe(200);
  return response.body;
}

async function confirmSecondFactor(person: Person): Promise<void> {
  const response = await person.browser.post('/api/auth/step-up', { code: codeFor(env, person) });
  env.clock.advance();
  expect(response.status).toBe(200);
}

/** Signs in on a browser the person has never used; the device waits for approval. */
async function newDeviceFor(person: Person): Promise<Browser> {
  const browser = new Browser(env.app);
  browser.userAgent = `second-device-of-${person.email}`;
  await browser.post('/api/auth/login', { email: person.email, password: person.password });
  const result = await browser.post<{ status: string }>('/api/auth/login/verify', {
    code: codeFor(env, person),
  });
  env.clock.advance();
  expect(result.body.status).toBe('device_pending');
  return browser;
}

describe('an employee', () => {
  it('sees only the items that are theirs', async () => {
    expect(ids(await itemsOf(s.ana, s.tarefas))).toEqual([s.itemAna]);
    expect(ids(await itemsOf(s.bruno, s.tarefas))).toEqual([s.itemBruno]);
    expect(ids(await itemsOf(s.owner, s.tarefas))).toEqual(
      [s.itemAna, s.itemBruno, s.itemNobody].sort(),
    );
  });

  it("cannot reach a colleague's item, even knowing its id", async () => {
    for (const hidden of [s.itemBruno, s.itemNobody, s.itemMoney]) {
      const edit = await s.ana.browser.patch<ErrorBody>(`/api/items/${hidden}`, {
        title: 'invadido',
      });
      expect(edit.status).toBe(404);
      const assign = await s.ana.browser.put(`/api/items/${hidden}/assignees`, {
        userIds: [s.ana.id],
      });
      expect(assign.status).toBe(404);
    }
    // Exactly the answer given for something that does not exist.
    const missing = await s.ana.browser.patch(`/api/items/${randomUUID()}`, { title: 'x' });
    expect(missing.status).toBe(404);

    const untouched = await itemsOf(s.owner, s.tarefas);
    expect(untouched.every((item) => item.title !== 'invadido')).toBe(true);
    expect(untouched.find((item) => item.id === s.itemBruno)?.assignees).toEqual([s.bruno.id]);
  });

  it('works on their own items but cannot hand them to someone else', async () => {
    const edited = await s.ana.browser.patch<Item>(`/api/items/${s.itemAna}`, {
      description: 'feito',
    });
    expect(edited.status).toBe(200);
    expect(edited.body.description).toBe('feito');

    const delegate = await s.ana.browser.put(`/api/items/${s.itemAna}/assignees`, {
      userIds: [s.ana.id, s.bruno.id],
    });
    expect(delegate.status).toBe(403);
    expect(ids(await itemsOf(s.bruno, s.tarefas))).toEqual([s.itemBruno]);
  });

  it('keeps what they create out of colleagues’ sight', async () => {
    const created = await s.ana.browser.post<Item>(`/api/lists/${s.tarefas}/items`, {
      title: 'Anotação da Ana',
    });
    expect(created.status).toBe(200);
    expect(created.body.createdBy).toBe(s.ana.id);

    expect(ids(await itemsOf(s.ana, s.tarefas))).toContain(created.body.id);
    expect(ids(await itemsOf(s.bruno, s.tarefas))).not.toContain(created.body.id);
    expect(ids(await itemsOf(s.owner, s.tarefas))).toContain(created.body.id);
  });

  it('navigates only to what was granted', async () => {
    const tree = await treeOf(s.ana);
    expect(ids(tree.spaces)).toEqual([s.operacao]);
    expect(ids(tree.folders)).toEqual([s.equipe]);
    expect(tree.lists).toEqual([
      expect.objectContaining({ id: s.tarefas, level: 'edit', itemScope: 'assigned' }),
    ]);

    for (const list of [s.perfis, s.dinheiro, randomUUID()]) {
      expect((await s.ana.browser.get(`/api/lists/${list}/items`)).status).toBe(404);
      const write = await s.ana.browser.post(`/api/lists/${list}/items`, { title: 'x' });
      expect(write.status).toBe(404);
    }
  });

  it('has no view of other people, the audit trail or security alerts', async () => {
    for (const url of ['/api/users', '/api/audit', '/api/audit/verify', '/api/alerts']) {
      expect((await s.ana.browser.get(url)).status).toBe(403);
    }
    expect((await s.ana.browser.get(`/api/users/${s.bruno.id}/grants`)).status).toBe(404);

    const devices = await s.ana.browser.get<{ userId: string }[]>('/api/devices');
    expect(devices.status).toBe(200);
    expect(devices.body.length).toBeGreaterThan(0);
    expect(devices.body.every((device) => device.userId === s.ana.id)).toBe(true);
  });

  it('cannot give themselves more than they were given', async () => {
    const b = s.ana.browser;
    expect((await b.patch(`/api/users/${s.ana.id}`, { role: 'owner' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.ana.id}`, { role: 'manager' })).status).toBe(403);
    expect(
      (await b.put(`/api/users/${s.ana.id}/capabilities`, { capabilities: ['users.manage'] }))
        .status,
    ).toBe(403);
    expect(
      (
        await b.put('/api/grants', {
          userId: s.ana.id,
          scopeType: 'list',
          scopeId: s.tarefas,
          level: 'manage',
          itemScope: 'all',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await b.put('/api/grants', {
          userId: s.ana.id,
          scopeType: 'list',
          scopeId: s.perfis,
          level: 'view',
        })
      ).status,
    ).toBe(404);
    expect(
      (await b.post('/api/users', { email: 'x@exemplo.test', name: 'X', role: 'employee' })).status,
    ).toBe(403);
    expect((await b.post('/api/spaces', { name: 'Meu espaço' })).status).toBe(403);
    expect(
      (await b.post('/api/lists', { spaceId: s.operacao, folderId: s.equipe, name: 'Minha' }))
        .status,
    ).toBe(403);

    // Their own display name is theirs to change.
    expect((await b.patch(`/api/users/${s.ana.id}`, { name: 'Ana S.' })).status).toBe(200);

    const me = await b.get<{ user: { role: string }; capabilities: string[] }>('/api/me');
    expect(me.body.user.role).toBe('employee');
    expect(me.body.capabilities).toEqual([]);
    expect(ids(await itemsOf(s.ana, s.tarefas))).not.toContain(s.itemBruno);
  });
});

describe('an administrator', () => {
  it('starts with nothing: the role alone opens no data', async () => {
    const tree = await treeOf(s.nuno);
    expect(tree).toEqual({ spaces: [], folders: [], lists: [] });
    for (const list of [s.tarefas, s.perfis, s.dinheiro]) {
      expect((await s.nuno.browser.get(`/api/lists/${list}/items`)).status).toBe(404);
    }
    for (const url of ['/api/users', '/api/audit', '/api/alerts']) {
      expect((await s.nuno.browser.get(url)).status).toBe(403);
    }
    const devices = await s.nuno.browser.get<{ userId: string }[]>('/api/devices');
    expect(devices.body.every((device) => device.userId === s.nuno.id)).toBe(true);
  });

  it('sees the areas granted to them and nothing beside them', async () => {
    const tree = await treeOf(s.marta);
    expect(ids(tree.spaces)).toEqual([s.operacao]);
    expect(ids(tree.lists)).toEqual([s.tarefas, s.perfis].sort());
    expect(tree.lists.every((list) => list.level === 'manage' && list.itemScope === 'all')).toBe(
      true,
    );
    expect((await itemsOf(s.marta, s.tarefas)).length).toBeGreaterThanOrEqual(3);

    expect((await s.marta.browser.get(`/api/lists/${s.dinheiro}/items`)).status).toBe(404);
    expect((await s.marta.browser.get('/api/alerts')).status).toBe(403);
    expect((await s.marta.browser.get('/api/audit')).status).toBe(403);
  });

  it('cannot hand out what they do not have', async () => {
    const grant = (body: Record<string, unknown>): Promise<{ status: number }> =>
      s.marta.browser.put('/api/grants', body);

    // Areas outside their own.
    expect(
      (await grant({ userId: s.ana.id, scopeType: 'list', scopeId: s.dinheiro, level: 'view' }))
        .status,
    ).toBe(404);
    expect(
      (await grant({ userId: s.ana.id, scopeType: 'space', scopeId: s.financeiro, level: 'view' }))
        .status,
    ).toBe(404);
    // People at or above their own rank, and themselves.
    for (const userId of [s.nuno.id, s.owner.id, s.marta.id]) {
      expect(
        (await grant({ userId, scopeType: 'list', scopeId: s.tarefas, level: 'view' })).status,
      ).toBe(403);
    }
    expect((await treeOf(s.nuno)).lists).toEqual([]);
  });

  it('can delegate inside their own area, and the owners hear about it', async () => {
    const granted = await s.marta.browser.put<Grant>('/api/grants', {
      userId: s.ana.id,
      scopeType: 'list',
      scopeId: s.perfis,
      level: 'view',
    });
    expect(granted.status).toBe(200);
    expect(granted.body.itemScope).toBe('assigned');
    expect(ids((await treeOf(s.ana)).lists)).toEqual([s.tarefas, s.perfis].sort());

    const alerts =
      await s.owner.browser.get<{ kind: string; actorUserId: string | null }[]>('/api/alerts');
    expect(
      alerts.body.some((a) => a.kind === 'permission_changed' && a.actorUserId === s.marta.id),
    ).toBe(true);
    const trail = await s.owner.browser.get<{ actorUserId: string | null; targetId: string }[]>(
      '/api/audit?action=access_grants.insert',
    );
    expect(
      trail.body.some((entry) => entry.actorUserId === s.marta.id && entry.targetId === s.ana.id),
    ).toBe(true);

    expect((await s.marta.browser.delete(`/api/grants/${granted.body.id}`)).status).toBe(200);
    expect(ids((await treeOf(s.ana)).lists)).toEqual([s.tarefas]);
  });

  it('cannot climb the chain of command', async () => {
    const b = s.marta.browser;
    for (const role of ['admin', 'owner']) {
      const created = await b.post('/api/users', {
        email: `novo-${role}@exemplo.test`,
        name: 'Novo',
        role,
      });
      expect(created.status).toBe(403);
    }
    expect((await b.patch(`/api/users/${s.ana.id}`, { role: 'admin' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.ana.id}`, { role: 'owner' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.marta.id}`, { role: 'owner' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.nuno.id}`, { status: 'suspended' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.owner.id}`, { status: 'suspended' })).status).toBe(403);
    expect((await b.patch(`/api/users/${s.owner.id}`, { role: 'employee' })).status).toBe(403);
    expect(
      (await b.put(`/api/users/${s.marta.id}/capabilities`, { capabilities: ['audit.view'] }))
        .status,
    ).toBe(403);
    // Resetting an owner's access would be a way to take the account over.
    expect((await b.post(`/api/users/${s.owner.id}/invite`)).status).toBe(403);
    expect((await b.post(`/api/users/${s.owner.id}/revoke-sessions`)).status).toBe(403);

    const people =
      await s.owner.browser.get<{ id: string; role: string; status: string }[]>('/api/users');
    const roleOf = (id: string): string | undefined => people.body.find((p) => p.id === id)?.role;
    expect(roleOf(s.ana.id)).toBe('employee');
    expect(roleOf(s.marta.id)).toBe('admin');
    expect(people.body.filter((p) => p.role === 'owner')).toHaveLength(1);
    expect(people.body.every((p) => p.status === 'active')).toBe(true);
    expect((await s.owner.browser.get('/api/me')).status).toBe(200);
  });

  it('administers people below them when an owner allowed it', async () => {
    const created = await s.marta.browser.post<{ user: { id: string; status: string } }>(
      '/api/users',
      { email: 'caio@exemplo.test', name: 'Caio Dias', role: 'employee' },
    );
    expect(created.status).toBe(200);
    expect(created.body.user.status).toBe('invited');
    const cancelled = await s.marta.browser.patch(`/api/users/${created.body.user.id}`, {
      status: 'suspended',
    });
    expect(cancelled.status).toBe(200);
  });

  it('approves devices only for people below them', async () => {
    await newDeviceFor(s.nuno);
    const anasPhone = await newDeviceFor(s.ana);

    const visible =
      await s.marta.browser.get<{ id: string; userId: string; status: string }[]>('/api/devices');
    expect(visible.body.some((d) => d.userId === s.nuno.id)).toBe(false);
    expect(visible.body.some((d) => d.userId === s.owner.id)).toBe(false);

    const everything =
      await s.owner.browser.get<{ id: string; userId: string; status: string }[]>('/api/devices');
    const nunos = everything.body.find((d) => d.userId === s.nuno.id && d.status === 'pending');
    const anas = everything.body.find((d) => d.userId === s.ana.id && d.status === 'pending');
    expect(nunos).toBeDefined();
    expect(anas).toBeDefined();

    const overreach = await s.marta.browser.post(`/api/devices/${nunos?.id}/decision`, {
      decision: 'approve',
    });
    expect(overreach.status).toBe(404);
    const approved = await s.marta.browser.post(`/api/devices/${anas?.id}/decision`, {
      decision: 'approve',
    });
    expect(approved.status).toBe(200);

    await anasPhone.post('/api/auth/login', { email: s.ana.email, password: s.ana.password });
    const signedIn = await anasPhone.post<{ status: string }>('/api/auth/login/verify', {
      code: codeFor(env, s.ana),
    });
    env.clock.advance();
    expect(signedIn.body.status).toBe('authenticated');

    // Someone other than an owner approved a device: the owners are told.
    const alerts =
      await s.owner.browser.get<{ kind: string; actorUserId: string | null }[]>('/api/alerts');
    expect(
      alerts.body.some((a) => a.kind === 'device_approved' && a.actorUserId === s.marta.id),
    ).toBe(true);
  });
});

describe('grants', () => {
  it('need a freshly confirmed second factor', async () => {
    await expireStepUp(env, s.owner);
    const body = { userId: s.nuno.id, scopeType: 'list', scopeId: s.perfis, level: 'view' };
    const refused = await s.owner.browser.put<ErrorBody>('/api/grants', body);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('step_up_required');
    expect((await treeOf(s.nuno)).lists).toEqual([]);

    await confirmSecondFactor(s.owner);
    const granted = await s.owner.browser.put<Grant>('/api/grants', body);
    expect(granted.status).toBe(200);
    expect(ids((await treeOf(s.nuno)).lists)).toEqual([s.perfis]);
    expect((await s.owner.browser.delete(`/api/grants/${granted.body.id}`)).status).toBe(200);
    expect((await treeOf(s.nuno)).lists).toEqual([]);
  });

  it('let the most specific rule win: "none" on a list hides it inside a granted space', async () => {
    const hidden = await s.owner.browser.put<Grant>('/api/grants', {
      userId: s.marta.id,
      scopeType: 'list',
      scopeId: s.perfis,
      level: 'none',
    });
    expect(hidden.status).toBe(200);
    expect(ids((await treeOf(s.marta)).lists)).toEqual([s.tarefas]);
    expect((await s.marta.browser.get(`/api/lists/${s.perfis}/items`)).status).toBe(404);
    // And she can no longer delegate what she can no longer see.
    const delegate = await s.marta.browser.put('/api/grants', {
      userId: s.ana.id,
      scopeType: 'list',
      scopeId: s.perfis,
      level: 'view',
    });
    expect(delegate.status).toBe(404);

    expect((await s.owner.browser.delete(`/api/grants/${hidden.body.id}`)).status).toBe(200);
    expect(ids((await treeOf(s.marta)).lists)).toEqual([s.tarefas, s.perfis].sort());
  });

  it('open a whole list to an employee only when someone with authority says so', async () => {
    const widen = await s.owner.browser.put<Grant>('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'edit',
      itemScope: 'all',
    });
    expect(widen.status).toBe(200);
    expect(ids(await itemsOf(s.bruno, s.tarefas))).toEqual(
      expect.arrayContaining([s.itemAna, s.itemBruno, s.itemNobody]),
    );

    const narrow = await s.owner.browser.put<Grant>('/api/grants', {
      userId: s.bruno.id,
      scopeType: 'list',
      scopeId: s.tarefas,
      level: 'edit',
      itemScope: 'assigned',
    });
    expect(narrow.status).toBe(200);
    expect(ids(await itemsOf(s.bruno, s.tarefas))).toEqual([s.itemBruno]);
  });
});

describe('sensitive lists', () => {
  it('need the second factor again, and every opening is recorded', async () => {
    await expireStepUp(env, s.owner);
    const refused = await s.owner.browser.get<ErrorBody>(`/api/lists/${s.dinheiro}/items`);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('step_up_required');

    await confirmSecondFactor(s.owner);
    expect(ids(await itemsOf(s.owner, s.dinheiro))).toEqual([s.itemMoney]);

    const trail = await s.owner.browser.get<{ actorUserId: string | null; targetId: string }[]>(
      '/api/audit?action=list.sensitive_viewed',
    );
    expect(
      trail.body.some((entry) => entry.actorUserId === s.owner.id && entry.targetId === s.dinheiro),
    ).toBe(true);
  });
});

describe('the last owner', () => {
  it('cannot be demoted or suspended, so the instance is never left without one', async () => {
    const demoted = await s.owner.browser.patch<ErrorBody>(`/api/users/${s.owner.id}`, {
      role: 'admin',
    });
    expect(demoted.status).toBe(409);
    const suspended = await s.owner.browser.patch<ErrorBody>(`/api/users/${s.owner.id}`, {
      status: 'suspended',
    });
    expect(suspended.status).toBe(409);
    expect((await s.owner.browser.get('/api/me')).status).toBe(200);
  });
});
