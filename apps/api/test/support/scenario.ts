import pg from 'pg';
import { inject } from 'vitest';
import { digest } from '../../src/crypto/tokens.js';
import { addPerson, setUpOwner, type Person, type TestEnv } from './env.js';

/**
 * A small company used by the authorization tests.
 *
 *   Operação (space)
 *     Equipe (folder)
 *       Tarefas (list)   Ana: edit, own items only · Bruno: edit, own items only
 *       Perfis (list)
 *   Financeiro (space)
 *     Dinheiro (list, sensitive)
 *
 *   dona   owner
 *   marta  admin, may manage users and approve devices, manages "Operação"
 *   nuno   admin with no grants and no capabilities
 *   ana    employee
 *   bruno  employee
 */
export interface Scenario {
  owner: Person;
  marta: Person;
  nuno: Person;
  ana: Person;
  bruno: Person;
  operacao: string;
  equipe: string;
  tarefas: string;
  perfis: string;
  financeiro: string;
  dinheiro: string;
  /** In Tarefas: assigned to Ana, assigned to Bruno, assigned to nobody. */
  itemAna: string;
  itemBruno: string;
  itemNobody: string;
  /** In Dinheiro. */
  itemMoney: string;
}

async function must<T>(call: Promise<{ status: number; body: T }>, what: string): Promise<T> {
  const response = await call;
  if (response.status !== 200) {
    throw new Error(`${what} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export async function buildScenario(env: TestEnv): Promise<Scenario> {
  const owner = await setUpOwner(env);
  const o = owner.browser;

  const marta = await addPerson(env, owner, {
    email: 'marta@exemplo.test',
    name: 'Marta Admin',
    role: 'admin',
  });
  const nuno = await addPerson(env, owner, {
    email: 'nuno@exemplo.test',
    name: 'Nuno Admin',
    role: 'admin',
  });
  const ana = await addPerson(env, owner, {
    email: 'ana@exemplo.test',
    name: 'Ana Souza',
    role: 'employee',
  });
  const bruno = await addPerson(env, owner, {
    email: 'bruno@exemplo.test',
    name: 'Bruno Lima',
    role: 'employee',
  });

  await must(
    o.put(`/api/users/${marta.id}/capabilities`, {
      capabilities: ['users.manage', 'devices.approve'],
    }),
    'capabilities',
  );

  const operacao = (
    await must(o.post<{ id: string }>('/api/spaces', { name: 'Operação' }), 'space')
  ).id;
  const financeiro = (
    await must(o.post<{ id: string }>('/api/spaces', { name: 'Financeiro' }), 'space')
  ).id;
  const equipe = (
    await must(
      o.post<{ id: string }>('/api/folders', { spaceId: operacao, name: 'Equipe' }),
      'folder',
    )
  ).id;
  const newList = async (body: Record<string, unknown>): Promise<string> =>
    (await must(o.post<{ id: string }>('/api/lists', body), 'list')).id;
  const tarefas = await newList({ spaceId: operacao, folderId: equipe, name: 'Tarefas' });
  const perfis = await newList({ spaceId: operacao, folderId: equipe, name: 'Perfis' });
  const dinheiro = await newList({ spaceId: financeiro, name: 'Dinheiro', isSensitive: true });

  const grant = (body: Record<string, unknown>): Promise<unknown> =>
    must(o.put('/api/grants', body), 'grant');
  await grant({ userId: marta.id, scopeType: 'space', scopeId: operacao, level: 'manage' });
  await grant({ userId: ana.id, scopeType: 'list', scopeId: tarefas, level: 'edit' });
  await grant({ userId: bruno.id, scopeType: 'list', scopeId: tarefas, level: 'edit' });

  const newItem = async (list: string, title: string, assignee?: Person): Promise<string> => {
    const item = await must(o.post<{ id: string }>(`/api/lists/${list}/items`, { title }), 'item');
    if (assignee) {
      await must(o.put(`/api/items/${item.id}/assignees`, { userIds: [assignee.id] }), 'assign');
    }
    return item.id;
  };
  const itemAna = await newItem(tarefas, 'Tarefa da Ana', ana);
  const itemBruno = await newItem(tarefas, 'Tarefa do Bruno', bruno);
  const itemNobody = await newItem(tarefas, 'Tarefa sem dono');
  const itemMoney = await newItem(dinheiro, 'Conta principal');

  return {
    owner,
    marta,
    nuno,
    ana,
    bruno,
    operacao,
    equipe,
    tarefas,
    perfis,
    financeiro,
    dinheiro,
    itemAna,
    itemBruno,
    itemNobody,
    itemMoney,
  };
}

// ---------------------------------------------------------------------------
// Talking to the database directly, as the API's own roles
// ---------------------------------------------------------------------------

export type ServiceRole = 'cerebro_app' | 'cerebro_auth' | 'cerebro_forms';

/** A raw connection with exactly the privileges the API has. No API code involved. */
export async function connectAs(env: TestEnv, role: ServiceRole): Promise<pg.Client> {
  const shared = inject('testDatabase');
  const client = new pg.Client({
    ...env.dbConfig,
    user: role,
    password:
      role === 'cerebro_app'
        ? shared.appPassword
        : role === 'cerebro_auth'
          ? shared.authPassword
          : shared.formsPassword,
  });
  await client.connect();
  return client;
}

/** Starts a transaction bound to the person's real session. Returns false if the database refuses. */
export async function bind(client: pg.Client, person: Person): Promise<boolean> {
  const token = person.browser.cookies.get('__Host-cerebro_session');
  if (token === undefined) throw new Error('person has no session');
  await client.query('BEGIN');
  const result = await client.query('SELECT * FROM authz.begin_request($1, $2::inet)', [
    digest(token),
    '203.0.113.7',
  ]);
  return result.rowCount === 1;
}

export interface Attempt {
  ok: boolean;
  /** SQLSTATE when the database refused. */
  code?: string;
  rowCount: number;
  rows: Record<string, unknown>[];
}

/**
 * Runs one statement and reports what happened without aborting the
 * surrounding transaction (a savepoint absorbs the failure).
 */
export async function attempt(
  client: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<Attempt> {
  await client.query('SAVEPOINT attempt');
  try {
    const result = await client.query(text, values);
    await client.query('RELEASE SAVEPOINT attempt');
    return {
      ok: true,
      rowCount: result.rowCount ?? 0,
      rows: result.rows as Record<string, unknown>[],
    };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT attempt');
    const code = (error as { code?: unknown }).code;
    return { ok: false, rowCount: 0, rows: [], ...(typeof code === 'string' ? { code } : {}) };
  }
}

/** The same, outside any transaction. */
export async function attemptAlone(
  client: pg.Client,
  text: string,
  values: unknown[] = [],
): Promise<Attempt> {
  try {
    const result = await client.query(text, values);
    return {
      ok: true,
      rowCount: result.rowCount ?? 0,
      rows: result.rows as Record<string, unknown>[],
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return { ok: false, rowCount: 0, rows: [], ...(typeof code === 'string' ? { code } : {}) };
  }
}
