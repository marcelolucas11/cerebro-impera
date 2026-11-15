import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, expireStepUp, type TestEnv } from './support/env.js';
import {
  attempt,
  attemptAlone,
  bind,
  buildScenario,
  connectAs,
  type Attempt,
  type Scenario,
} from './support/scenario.js';

/*
 * The second layer of defence, tested on its own: these tests talk to
 * PostgreSQL directly with the API's own credentials, as an attacker would
 * after finding an SQL injection or stealing the service passwords. No API
 * code runs, so nothing here can pass thanks to a check made in TypeScript.
 */

let env: TestEnv;
let s: Scenario;
let app: pg.Client;
let auth: pg.Client;

beforeAll(async () => {
  env = await createTestEnv();
  s = await buildScenario(env);
  app = await connectAs(env, 'cerebro_app');
  auth = await connectAs(env, 'cerebro_auth');
});
afterAll(async () => {
  await app.end();
  await auth.end();
  await env.close();
});

/*
 * SQLSTATEs that mean "the database refused on purpose": 42501 is a missing
 * privilege or a row-level security violation, CB001..CB003 are raised by the
 * guards. Anything else (a typo in a test statement, a constraint) must not
 * count as a refusal, or a broken test would pass for the wrong reason.
 */
const REFUSALS = new Set(['42501', 'CB001', 'CB002', 'CB003']);

/** The database said no: a deliberate refusal, or a statement that touched no row. */
const refused = (result: Attempt): boolean =>
  result.ok ? result.rowCount === 0 : REFUSALS.has(result.code ?? '');

async function count(client: pg.Client, table: string, where = 'true'): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  );
  return result.rows[0]?.n ?? -1;
}

const BUSINESS_TABLES = [
  'app.instance_settings',
  'app.users',
  'app.user_capabilities',
  'app.spaces',
  'app.folders',
  'app.lists',
  'app.items',
  'app.item_assignees',
  'app.access_grants',
  'app.security_alerts',
  'audit.log',
];
const CREDENTIAL_TABLES = [
  'auth.credentials',
  'auth.totp',
  'auth.recovery_codes',
  'auth.devices',
  'auth.sessions',
  'auth.login_challenges',
  'auth.invites',
  'auth.throttle',
];

describe('a connection that has not proved who it is', () => {
  it('sees no business data at all', async () => {
    for (const table of BUSINESS_TABLES) {
      const result = await attemptAlone(app, `SELECT count(*)::int AS n FROM ${table}`);
      expect(result, table).toMatchObject({ ok: true, rows: [{ n: 0 }] });
    }
  });

  it('cannot read credentials, sessions or the request context', async () => {
    for (const table of [...CREDENTIAL_TABLES, 'authz.request_ctx', 'audit.chain_head']) {
      const result = await attemptAlone(app, `SELECT * FROM ${table} LIMIT 1`);
      expect(result, table).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('cannot claim to be someone', async () => {
    const forged = await attemptAlone(
      app,
      `INSERT INTO authz.request_ctx (pid, xact_start, user_id, session_id, step_up)
       VALUES (pg_backend_pid(), transaction_timestamp(), $1, gen_random_uuid(), true)`,
      [s.owner.id],
    );
    expect(forged).toMatchObject({ ok: false, code: '42501' });

    // Session variables carry no authority here, whatever their name.
    await app.query('BEGIN');
    for (const name of ['app.user_id', 'app.current_user_id', 'request.jwt.claim.sub']) {
      await app.query('SELECT set_config($1, $2, true)', [name, s.owner.id]);
    }
    expect(await count(app, 'app.items')).toBe(0);
    expect(await count(app, 'app.users')).toBe(0);

    // A made-up session token binds nothing.
    const guess = await app.query('SELECT * FROM authz.begin_request(sha256($1), NULL)', [
      Buffer.from('not-a-real-token'),
    ]);
    expect(guess.rowCount).toBe(0);
    expect(await count(app, 'app.items')).toBe(0);
    await app.query('ROLLBACK');
  });

  it('cannot step outside its role or switch the protections off', async () => {
    for (const statement of [
      'SET ROLE postgres',
      'SET SESSION AUTHORIZATION postgres',
      'ALTER TABLE app.items DISABLE ROW LEVEL SECURITY',
      'ALTER TABLE audit.log DISABLE TRIGGER ALL',
      'DROP POLICY items_select ON app.items',
      'CREATE POLICY open ON app.items FOR SELECT USING (true)',
      'GRANT SELECT ON auth.sessions TO cerebro_app',
      'ALTER ROLE cerebro_app BYPASSRLS',
      `CREATE FUNCTION app.backdoor() RETURNS uuid LANGUAGE sql SECURITY DEFINER AS 'SELECT NULL::uuid'`,
      'CREATE TABLE app.copy AS SELECT 1',
      `SELECT audit.append_entry(NULL, NULL, NULL, 'forged', NULL, NULL, '{}')`,
      `SELECT app.raise_alert('noise', 'info')`,
    ]) {
      const result = await attemptAlone(app, statement);
      expect(result, statement).toMatchObject({ ok: false, code: '42501' });
    }

    // With row security "off", PostgreSQL refuses the query instead of leaking rows.
    await app.query('SET row_security = off');
    const leak = await attemptAlone(app, 'SELECT count(*) FROM app.items');
    await app.query('RESET row_security');
    expect(leak).toMatchObject({ ok: false, code: '42501' });
  });

  it('is forgotten as soon as its transaction ends', async () => {
    expect(await bind(app, s.owner)).toBe(true);
    expect(await count(app, 'app.items', `list_id = '${s.tarefas}'`)).toBe(3);
    await app.query('COMMIT');

    // Same connection, next transaction: nobody is signed in any more.
    await app.query('BEGIN');
    expect(await count(app, 'app.items')).toBe(0);
    expect(await count(app, 'app.users')).toBe(0);
    await app.query('COMMIT');
    expect(await count(app, 'app.items')).toBe(0);
  });
});

describe('an employee, straight at the database', () => {
  it('still sees only what is theirs', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const items = await app.query<{ id: string }>('SELECT id FROM app.items');
    expect(items.rows.map((row) => row.id)).toEqual([s.itemAna]);
    const assignees = await app.query<{ item_id: string }>(
      'SELECT item_id FROM app.item_assignees',
    );
    expect(assignees.rows.map((row) => row.item_id)).toEqual([s.itemAna]);

    const people = await app.query<{ id: string }>('SELECT id FROM app.users');
    expect(people.rows.map((row) => row.id)).toEqual([s.ana.id]);
    const lists = await app.query<{ id: string }>('SELECT id FROM app.lists');
    expect(lists.rows.map((row) => row.id)).toEqual([s.tarefas]);
    const spaces = await app.query<{ id: string }>('SELECT id FROM app.spaces');
    expect(spaces.rows.map((row) => row.id)).toEqual([s.operacao]);
    const grants = await app.query<{ user_id: string }>('SELECT user_id FROM app.access_grants');
    expect(grants.rows.map((row) => row.user_id)).toEqual([s.ana.id]);

    expect(await count(app, 'audit.log')).toBe(0);
    expect(await count(app, 'app.security_alerts')).toBe(0);
    expect(await count(app, 'app.user_capabilities')).toBe(0);
    await app.query('ROLLBACK');
  });

  it("cannot touch a colleague's work", async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const edit = await attempt(app, `UPDATE app.items SET title = 'invadido' WHERE id = $1`, [
      s.itemBruno,
    ]);
    expect(edit).toMatchObject({ ok: true, rowCount: 0 });
    const editAll = await attempt(app, `UPDATE app.items SET title = 'invadido'`);
    expect(editAll).toMatchObject({ ok: true, rowCount: 1 }); // only her own row exists for her

    expect(refused(await attempt(app, 'DELETE FROM app.items'))).toBe(true);
    expect(
      refused(
        await attempt(app, 'UPDATE app.items SET list_id = $1 WHERE id = $2', [
          s.perfis,
          s.itemAna,
        ]),
      ),
    ).toBe(true);
    expect(
      refused(
        await attempt(
          app,
          `INSERT INTO app.items (id, list_id, title) VALUES (gen_random_uuid(), $1, 'x')`,
          [s.perfis],
        ),
      ),
    ).toBe(true);
    expect(
      refused(
        await attempt(app, 'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)', [
          s.itemAna,
          s.bruno.id,
        ]),
      ),
    ).toBe(true);
    expect(
      refused(
        await attempt(app, 'INSERT INTO app.item_assignees (item_id, user_id) VALUES ($1, $2)', [
          s.itemBruno,
          s.ana.id,
        ]),
      ),
    ).toBe(true);
    expect(refused(await attempt(app, 'DELETE FROM app.item_assignees'))).toBe(true);
    await app.query('ROLLBACK');

    const title = await env.admin.query<{ title: string }>(
      'SELECT title FROM app.items WHERE id = $1',
      [s.itemBruno],
    );
    expect(title.rows[0]?.title).toBe('Tarefa do Bruno');
  });

  it('cannot forge authorship', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const id = randomUUID();
    const created = await attempt(
      app,
      `INSERT INTO app.items (id, list_id, title, created_by) VALUES ($1, $2, 'em nome de outro', $3)`,
      [id, s.tarefas, s.bruno.id],
    );
    // Either refused outright, or stamped with the real author.
    if (created.ok) {
      const author = await app.query<{ created_by: string }>(
        'SELECT created_by FROM app.items WHERE id = $1',
        [id],
      );
      expect(author.rows[0]?.created_by).toBe(s.ana.id);
    }
    await app.query('ROLLBACK');
  });

  it('cannot raise their own access', async () => {
    expect(await bind(app, s.ana)).toBe(true);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.users SET role = 'owner' WHERE id = $1`, [s.ana.id]],
      [`UPDATE app.users SET role = 'manager' WHERE id = $1`, [s.ana.id]],
      [`UPDATE app.users SET role = 'owner'`, []],
      [`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.owner.id]],
      [`UPDATE app.users SET email = 'outra@exemplo.test' WHERE id = $1`, [s.ana.id]],
      [
        `INSERT INTO app.users (id, email, name, role) VALUES (gen_random_uuid(), 'x@exemplo.test', 'X', 'owner')`,
        [],
      ],
      [
        `INSERT INTO app.user_capabilities (user_id, capability) VALUES ($1, 'users.manage')`,
        [s.ana.id],
      ],
      [`UPDATE app.access_grants SET level = 'manage', item_scope = 'all'`, []],
      [
        `INSERT INTO app.access_grants (id, user_id, list_id, level, item_scope)
         VALUES (gen_random_uuid(), $1, $2, 'manage', 'all')`,
        [s.ana.id, s.perfis],
      ],
      [
        `INSERT INTO app.access_grants (id, user_id, space_id, level, item_scope)
         VALUES (gen_random_uuid(), $1, $2, 'view', 'all')`,
        [s.ana.id, s.financeiro],
      ],
      ['DELETE FROM app.access_grants', []],
      [`UPDATE app.instance_settings SET session_idle_minutes = 43200`, []],
      [`UPDATE app.lists SET is_sensitive = false`, []],
      [`INSERT INTO app.spaces (id, name) VALUES (gen_random_uuid(), 'meu')`, []],
      [`SELECT auth.create_invite($1, sha256('x'::bytea), 'reset')`, [s.owner.id]],
      [`SELECT auth.revoke_user_sessions($1)`, [s.owner.id]],
      [`SELECT * FROM audit.verify_chain()`, []],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(refused(result), text).toBe(true);
    }
    await app.query('ROLLBACK');

    const after = await env.admin.query<{ role: string; email: string }>(
      'SELECT role, email FROM app.users WHERE id = $1',
      [s.ana.id],
    );
    expect(after.rows[0]).toEqual({ role: 'employee', email: s.ana.email });
  });
});

describe('an administrator, straight at the database', () => {
  it('stays inside their own area', async () => {
    expect(await bind(app, s.marta)).toBe(true);
    const lists = await app.query<{ id: string }>('SELECT id FROM app.lists ORDER BY id');
    expect(lists.rows.map((row) => row.id)).toEqual([s.tarefas, s.perfis].sort());
    expect(await count(app, 'app.items', `list_id = '${s.dinheiro}'`)).toBe(0);
    expect(await count(app, 'app.items', `list_id = '${s.tarefas}'`)).toBe(3);
    expect(await count(app, 'app.spaces', `id = '${s.financeiro}'`)).toBe(0);

    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.access_grants (id, user_id, list_id, level, item_scope)
         VALUES (gen_random_uuid(), $1, $2, 'view', 'assigned')`,
        [s.ana.id, s.dinheiro],
      ],
      [
        `INSERT INTO app.access_grants (id, user_id, space_id, level, item_scope)
         VALUES (gen_random_uuid(), $1, $2, 'manage', 'all')`,
        [s.marta.id, s.financeiro],
      ],
      [
        `INSERT INTO app.access_grants (id, user_id, list_id, level, item_scope)
         VALUES (gen_random_uuid(), $1, $2, 'view', 'all')`,
        [s.nuno.id, s.tarefas],
      ],
      [`UPDATE app.lists SET is_sensitive = false WHERE id = $1`, [s.dinheiro]],
      [
        `INSERT INTO app.items (id, list_id, title) VALUES (gen_random_uuid(), $1, 'x')`,
        [s.dinheiro],
      ],
      [
        `UPDATE app.lists SET space_id = $1, folder_id = NULL WHERE id = $2`,
        [s.financeiro, s.tarefas],
      ],
      [`INSERT INTO app.spaces (id, name) VALUES (gen_random_uuid(), 'novo')`, []],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(refused(result), text).toBe(true);
    }
    await app.query('ROLLBACK');
  });

  it('stays below the owners and beside their peers', async () => {
    expect(await bind(app, s.marta)).toBe(true);
    const statements: [string, unknown[]][] = [
      [`UPDATE app.users SET role = 'owner' WHERE id = $1`, [s.marta.id]],
      [`UPDATE app.users SET role = 'admin' WHERE id = $1`, [s.ana.id]],
      [`UPDATE app.users SET role = 'owner' WHERE id = $1`, [s.ana.id]],
      [`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.nuno.id]],
      [`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.owner.id]],
      [`UPDATE app.users SET email = 'tomada@exemplo.test' WHERE id = $1`, [s.ana.id]],
      [
        `INSERT INTO app.users (id, email, name, role) VALUES (gen_random_uuid(), 'a@exemplo.test', 'A', 'admin')`,
        [],
      ],
      [
        `INSERT INTO app.users (id, email, name, role) VALUES (gen_random_uuid(), 'o@exemplo.test', 'O', 'owner')`,
        [],
      ],
      [
        `INSERT INTO app.user_capabilities (user_id, capability) VALUES ($1, 'audit.view')`,
        [s.marta.id],
      ],
      [`DELETE FROM app.user_capabilities WHERE user_id = $1`, [s.marta.id]],
      [`SELECT auth.create_invite($1, sha256('x'::bytea), 'reset')`, [s.owner.id]],
      [`SELECT auth.create_invite($1, sha256('x'::bytea), 'reset')`, [s.nuno.id]],
      [`SELECT auth.revoke_user_sessions($1)`, [s.owner.id]],
      [`UPDATE app.security_alerts SET acknowledged_at = now()`, []],
    ];
    for (const [text, values] of statements) {
      const result = await attempt(app, text, values);
      expect(refused(result), text).toBe(true);
    }
    expect(await count(app, 'audit.log')).toBe(0);
    expect(await count(app, 'app.security_alerts')).toBe(0);

    // What she is allowed to do does work, so the refusals above are not a broken harness.
    const allowed = await attempt(
      app,
      `INSERT INTO app.users (id, email, name, role) VALUES (gen_random_uuid(), 'e@exemplo.test', 'E', 'employee')`,
    );
    expect(allowed).toMatchObject({ ok: true, rowCount: 1 });
    await app.query('ROLLBACK');
  });
});

describe('sessions and devices', () => {
  it('hide a sensitive list until the second factor is confirmed again', async () => {
    await expireStepUp(env, s.owner);
    expect(await bind(app, s.owner)).toBe(true);
    expect(await count(app, 'app.items', `list_id = '${s.dinheiro}'`)).toBe(0);
    expect(await count(app, 'app.items', `list_id = '${s.tarefas}'`)).toBe(3);
    // Without it, even an owner cannot change permissions.
    expect(
      refused(
        await attempt(
          app,
          `INSERT INTO app.access_grants (id, user_id, list_id, level, item_scope)
           VALUES (gen_random_uuid(), $1, $2, 'view', 'all')`,
          [s.nuno.id, s.dinheiro],
        ),
      ),
    ).toBe(true);
    await app.query('ROLLBACK');

    await env.admin.query('UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1', [
      s.owner.id,
    ]);
    expect(await bind(app, s.owner)).toBe(true);
    expect(await count(app, 'app.items', `list_id = '${s.dinheiro}'`)).toBe(1);
    await app.query('ROLLBACK');
  });

  it('stop working the moment a session is revoked or a device loses approval', async () => {
    await env.admin.query('UPDATE auth.sessions SET revoked_at = now() WHERE user_id = $1', [
      s.bruno.id,
    ]);
    expect(await bind(app, s.bruno)).toBe(false);
    expect(await count(app, 'app.items')).toBe(0);
    await app.query('ROLLBACK');

    await env.admin.query(`UPDATE auth.devices SET status = 'revoked' WHERE user_id = $1`, [
      s.nuno.id,
    ]);
    expect(await bind(app, s.nuno)).toBe(false);
    await app.query('ROLLBACK');
  });
});

describe('the login service', () => {
  it('reaches credentials and nothing else', async () => {
    for (const table of [
      'app.spaces',
      'app.folders',
      'app.lists',
      'app.items',
      'app.item_assignees',
      'app.access_grants',
      'app.user_capabilities',
      'app.security_alerts',
      'audit.log',
      'authz.request_ctx',
    ]) {
      const result = await attemptAlone(auth, `SELECT * FROM ${table} LIMIT 1`);
      expect(result, table).toMatchObject({ ok: false, code: '42501' });
    }
    const bindAttempt = await attemptAlone(
      auth,
      `SELECT * FROM authz.begin_request(sha256('x'::bytea), NULL)`,
    );
    expect(bindAttempt).toMatchObject({ ok: false, code: '42501' });
  });

  it('cannot create owners, promote anyone or reopen the setup', async () => {
    const statements: [string, unknown[]][] = [
      [
        `INSERT INTO app.users (id, email, name, role, status)
         VALUES (gen_random_uuid(), 'intruso@exemplo.test', 'Intruso', 'owner', 'active')`,
        [],
      ],
      [`UPDATE app.users SET role = 'owner' WHERE id = $1`, [s.ana.id]],
      [`UPDATE app.users SET status = 'suspended' WHERE id = $1`, [s.owner.id]],
      [`UPDATE app.instance_settings SET setup_completed_at = NULL`, []],
      [`DELETE FROM app.users WHERE id = $1`, [s.ana.id]],
    ];
    for (const [text, values] of statements) {
      const result = await attemptAlone(auth, text, values);
      expect(refused(result), text).toBe(true);
    }
    const owners = await env.admin.query(
      `SELECT 1 FROM app.users WHERE role = 'owner' AND status = 'active'`,
    );
    expect(owners.rowCount).toBe(1);
  });
});

describe('the audit trail', () => {
  it('records permission changes by itself, whoever makes them and however', async () => {
    const before = await env.admin.query(
      `SELECT 1 FROM audit.log WHERE action = 'access_grants.insert'`,
    );
    expect(await bind(app, s.owner)).toBe(true);
    // Plain SQL, no API involved.
    await app.query(
      `INSERT INTO app.access_grants (id, user_id, list_id, level, item_scope)
       VALUES (gen_random_uuid(), $1, $2, 'view', 'assigned')`,
      [s.nuno.id, s.perfis],
    );
    await app.query('COMMIT');
    const after = await env.admin.query<{ actor_user_id: string; target_id: string }>(
      `SELECT actor_user_id, target_id FROM audit.log
       WHERE action = 'access_grants.insert' ORDER BY seq DESC`,
    );
    expect(after.rowCount).toBe((before.rowCount ?? 0) + 1);
    expect(after.rows[0]).toEqual({ actor_user_id: s.owner.id, target_id: s.nuno.id });
  });

  it('cannot be edited or erased by the API roles, even acting for an owner', async () => {
    expect(await bind(app, s.owner)).toBe(true);
    expect(await count(app, 'audit.log')).toBeGreaterThan(0);
    for (const statement of [
      `UPDATE audit.log SET action = 'nada'`,
      'DELETE FROM audit.log',
      'TRUNCATE audit.log',
      `INSERT INTO audit.log (seq, at, actor_db_role, action, prev_hash, hash)
       VALUES (999999, now(), 'x', 'forjado', '\\x00', '\\x00')`,
      `UPDATE audit.chain_head SET last_seq = 0`,
      'DELETE FROM audit.chain_head',
    ]) {
      const result = await attempt(app, statement);
      expect(result, statement).toMatchObject({ ok: false, code: '42501' });
    }
    await app.query('ROLLBACK');

    for (const statement of ['DELETE FROM audit.log', `UPDATE audit.log SET action = 'nada'`]) {
      const result = await attemptAlone(auth, statement);
      expect(result, statement).toMatchObject({ ok: false, code: '42501' });
    }
  });

  it('rejects changes even from the database owner', async () => {
    const superuser = await env.admin.connect();
    try {
      for (const statement of [
        `UPDATE audit.log SET action = 'nada' WHERE seq = 1`,
        'DELETE FROM audit.log WHERE seq = 1',
        'TRUNCATE audit.log',
        'DELETE FROM audit.chain_head',
      ]) {
        const result = await attemptAlone(superuser, statement);
        expect(result, statement).toMatchObject({ ok: false, code: 'CB001' });
      }
    } finally {
      superuser.release();
    }
  });

  it('exposes tampering by someone with full control of the database', async () => {
    const verify = async (): Promise<{
      ok: boolean;
      checked: number;
      brokenSeq: number | null;
    }> => {
      const response = await s.owner.browser.get<{
        ok: boolean;
        checked: number;
        brokenSeq: number | null;
      }>('/api/audit/verify');
      expect(response.status).toBe(200);
      return response.body;
    };
    const intact = await verify();
    expect(intact.ok).toBe(true);
    expect(intact.checked).toBeGreaterThan(10);
    expect(intact.brokenSeq).toBeNull();

    // Someone with superuser access switches the guards off and removes the newest entry...
    const last = intact.checked;
    await env.admin.query('ALTER TABLE audit.log DISABLE TRIGGER log_immutable');
    await env.admin.query('DELETE FROM audit.log WHERE seq = $1', [last]);
    expect(await verify()).toMatchObject({ ok: false, brokenSeq: last });

    // ...and rewrites an older one.
    await env.admin.query(
      `UPDATE audit.log SET metadata = metadata || '{"forged": true}' WHERE seq = 5`,
    );
    await env.admin.query('ALTER TABLE audit.log ENABLE TRIGGER log_immutable');
    expect(await verify()).toMatchObject({ ok: false, brokenSeq: 5 });
  });
});

describe('the schema itself', () => {
  const SCHEMAS = `('app', 'auth', 'audit', 'authz')`;

  it('has row-level security on every table, so a forgotten policy fails closed', async () => {
    const unprotected = await env.admin.query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ${SCHEMAS} AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity`,
    );
    expect(unprotected.rows).toEqual([]);
  });

  it('grants no function to PUBLIC', async () => {
    const open = await env.admin.query<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ${SCHEMAS} AND has_function_privilege('public', p.oid, 'EXECUTE')`,
    );
    expect(open.rows).toEqual([]);
  });

  it('pins search_path on every function that runs with elevated rights', async () => {
    const loose = await env.admin.query<{ name: string }>(
      `SELECT p.oid::regprocedure::text AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname IN ${SCHEMAS} AND p.prosecdef
         AND NOT EXISTS (
           SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) AS setting
           WHERE setting LIKE 'search_path=%')`,
    );
    expect(loose.rows).toEqual([]);
  });

  it('runs the API as roles with no way around any of this', async () => {
    const roles = await env.admin.query(
      `SELECT rolname FROM pg_roles
       WHERE rolname IN ('cerebro_app', 'cerebro_auth')
         AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)`,
    );
    expect(roles.rows).toEqual([]);

    const owned = await env.admin.query(
      `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
       WHERE r.rolname IN ('cerebro_app', 'cerebro_auth')`,
    );
    expect(owned.rows).toEqual([]);

    const memberships = await env.admin.query(
      `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
       WHERE r.rolname IN ('cerebro_app', 'cerebro_auth')`,
    );
    expect(memberships.rows).toEqual([]);

    // The role that serves ordinary requests has no privilege on any credential table.
    const reach = await env.admin.query<{ name: string }>(
      `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'auth' AND c.relkind = 'r'
         AND has_table_privilege('cerebro_app', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')`,
    );
    expect(reach.rows).toEqual([]);
  });
});
