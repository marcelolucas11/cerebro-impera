import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.js';
import { DEFAULT_REQUESTS_PER_MINUTE, type Config } from '../../src/config.js';
import { PasswordHasher } from '../../src/crypto/password.js';
import { totpCodeAt } from '../../src/crypto/totp.js';
import { Vault } from '../../src/crypto/vault.js';
import { closePools, createPools } from '../../src/db.js';
import type { Deps } from '../../src/deps.js';
import { ensureSetupToken } from '../../src/modules/auth.js';
import type { Scanner } from '../../src/files/scanner.js';
import type { Updater } from '../../src/updates/client.js';
import { FileStore } from '../../src/files/store.js';

export const ORIGIN = 'https://cerebro.exemplo.test';
export const FORMS_ORIGIN = 'https://formularios.exemplo.test';

export interface TestEnv {
  deps: Deps;
  app: FastifyInstance;
  /** Superuser pool on this test's database, for arranging and inspecting state. */
  admin: pg.Pool;
  dbConfig: { host: string; port: number; database: string };
  clock: { now: number; advance: (ms?: number) => void };
  setupToken: () => string;
  close: () => Promise<void>;
}

/** A private, fully migrated database plus an API instance wired to it. */
/**
 * A stand-in for the antivirus: finds the industry's harmless test signature
 * (EICAR), the same way a real one would, and nothing else.
 */
// Built at run time so this source file itself never looks infected to a scanner on disk.
export const EICAR = [
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
  'EICAR-STANDARD',
  '-ANTIVIRUS-TEST-FILE!$H+H*',
].join('');
export const testScanner: Scanner = {
  async scan(chunks) {
    let seen = '';
    for await (const chunk of chunks) {
      seen = (seen + chunk.toString('latin1')).slice(-200_000);
      if (seen.includes(EICAR)) return 'infected';
    }
    return 'clean';
  },
};

export async function createTestEnv(
  options: {
    webRoot?: string;
    scanner?: Scanner | null;
    requestsPerMinute?: number;
    updater?: Updater | null;
    backupStatusFile?: string;
  } = {},
): Promise<TestEnv> {
  const shared = inject('testDatabase');
  const adminUrl = new URL(shared.adminUrl);
  const database = `${shared.template.replace(/template$/, '')}${randomBytes(6).toString('hex')}`;

  const maintenance = new pg.Client({ connectionString: shared.adminUrl });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE "${database}" TEMPLATE "${shared.template}"`);
  await maintenance.end();

  const host = adminUrl.hostname;
  const port = Number(adminUrl.port || '5432');
  const databaseUrl = new URL(shared.adminUrl);
  databaseUrl.pathname = `/${database}`;
  const admin = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });

  const configDir = mkdtempSync(join(tmpdir(), 'cerebro-test-'));
  const config: Config = {
    env: 'test',
    publicOrigin: ORIGIN,
    listen: { host: '127.0.0.1', port: 0 },
    trustProxy: false,
    requestsPerMinute: options.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE,
    db: {
      host,
      port,
      database,
      appPassword: shared.appPassword,
      authPassword: shared.authPassword,
    },
    masterKey: randomBytes(32),
    // Deliberately cheap: these tests are about behaviour, not hashing cost.
    argon2: { memoryCost: 4096, timeCost: 1, parallelism: 1 },
    setupTokenFile: join(configDir, 'setup-token'),
    webRoot: options.webRoot ?? null,
    files: { dir: join(configDir, 'files'), maxBytes: 20 * 1024 * 1024 },
    antivirus: { kind: 'off' },
    version: '1.4.0',
    updater: null,
    backupStatusFile: options.backupStatusFile ?? null,
    formsOrigin: FORMS_ORIGIN,
  };

  const clock = {
    now: Date.UTC(2030, 0, 1, 12, 0, 0),
    /** Moves past the current 30-second code window (codes are single-use). */
    advance(ms = 31_000): void {
      this.now += ms;
    },
  };
  const pools = createPools(config.db, { max: 5 });
  const deps: Deps = {
    config,
    pools,
    vault: new Vault(config.masterKey),
    hasher: new PasswordHasher(config.argon2),
    now: () => clock.now,
    files: new FileStore(config.files.dir),
    scanner: options.scanner === undefined ? testScanner : options.scanner,
    updater: options.updater ?? null,
  };
  const app = await buildApp(deps);
  await ensureSetupToken(deps);

  return {
    deps,
    app,
    admin,
    dbConfig: { host, port, database },
    clock,
    setupToken: () => readFileSync(config.setupTokenFile, 'utf8').trim(),
    async close() {
      await app.close();
      await closePools(pools);
      await admin.end();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
}

/** A browser stand-in: keeps cookies between requests and sends the right Origin. */
export class Browser {
  readonly cookies = new Map<string, string>();
  readonly #app: FastifyInstance;
  userAgent = 'vitest-browser';

  constructor(app: FastifyInstance) {
    this.#app = app;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...(method === 'GET' ? {} : { origin: ORIGIN }),
      ...extraHeaders,
    };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await this.#app.inject({
      method,
      url,
      headers,
      ...(body === undefined ? {} : { payload: body as object }),
    });
    for (const cookie of response.cookies) {
      if (cookie.value === '' || cookie.maxAge === 0) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    const text = response.body;
    return {
      status: response.statusCode,
      body: (text === '' ? undefined : JSON.parse(text)) as T,
      headers: response.headers,
    };
  }

  /** Sends and receives raw bytes: file parts going in, file content coming out. */
  async bytes(
    method: 'GET' | 'PUT',
    url: string,
    payload?: Buffer,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; body: Buffer; headers: ApiResponse['headers'] }> {
    const headers: Record<string, string> = {
      'user-agent': this.userAgent,
      ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/octet-stream' }),
      ...extraHeaders,
    };
    if (this.cookies.size > 0) {
      headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    }
    const response = await this.#app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: response.statusCode, body: response.rawPayload, headers: response.headers };
  }

  get<T = unknown>(url: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', url);
  }
  post<T = unknown>(url: string, body: unknown = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', url, body);
  }
  put<T = unknown>(url: string, body: unknown = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', url, body);
  }
  patch<T = unknown>(url: string, body: unknown = {}): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', url, body);
  }
  delete<T = unknown>(url: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', url, body);
  }
}

export interface Person {
  id: string;
  email: string;
  password: string;
  totpSecret: string;
  browser: Browser;
}

export const STRONG_PASSWORD = 'lagoa-verde-73-tijolo-quente'; // gitleaks:allow (senha fictícia de teste)

/** The current second-factor code for a person, at the test clock's time. */
export function codeFor(env: TestEnv, person: { totpSecret: string }): string {
  return totpCodeAt(person.totpSecret, env.clock.now);
}

/** Runs the first-run wizard and returns the owner, signed in. */
export async function setUpOwner(env: TestEnv, email = 'dona@exemplo.test'): Promise<Person> {
  const browser = new Browser(env.app);
  const setupToken = env.setupToken();
  const totp = await browser.post<{ secret: string }>('/api/setup/totp', { setupToken, email });
  if (totp.status !== 200) throw new Error(`setup/totp failed: ${JSON.stringify(totp.body)}`);
  const done = await browser.post('/api/setup', {
    setupToken,
    instanceName: 'Empresa Exemplo',
    email,
    name: 'Dona Primeira',
    password: STRONG_PASSWORD,
    totpSecret: totp.body.secret,
    totpCode: totpCodeAt(totp.body.secret, env.clock.now),
  });
  if (done.status !== 200) throw new Error(`setup failed: ${JSON.stringify(done.body)}`);
  const me = await browser.get<{ user: { id: string } }>('/api/me');
  env.clock.advance();
  return {
    id: me.body.user.id,
    email,
    password: STRONG_PASSWORD,
    totpSecret: totp.body.secret,
    browser,
  };
}

/**
 * Creates a person the way it happens for real: an administrator invites
 * them, they choose a password and enrol a second factor on their own
 * browser, the administrator approves that device, and they sign in.
 */
export async function addPerson(
  env: TestEnv,
  admin: Person,
  input: { email: string; name: string; role: 'employee' | 'manager' | 'admin' | 'owner' },
): Promise<Person> {
  const created = await admin.browser.post<{ user: { id: string }; invite: { token: string } }>(
    '/api/users',
    input,
  );
  if (created.status !== 200) throw new Error(`invite failed: ${JSON.stringify(created.body)}`);

  const browser = new Browser(env.app);
  browser.userAgent = `browser-of-${input.email}`;
  const accepted = await browser.post('/api/auth/invite/accept', {
    token: created.body.invite.token,
    password: STRONG_PASSWORD,
  });
  if (accepted.status !== 200) throw new Error(`accept failed: ${JSON.stringify(accepted.body)}`);
  const enrol = await browser.post<{ secret: string }>('/api/auth/totp/enroll');
  const person: Person = {
    id: created.body.user.id,
    email: input.email,
    password: STRONG_PASSWORD,
    totpSecret: enrol.body.secret,
    browser,
  };
  const confirmed = await browser.post<{ status: string }>('/api/auth/totp/confirm', {
    code: codeFor(env, person),
  });
  if (confirmed.body.status !== 'device_pending') {
    throw new Error(`expected a pending device, got ${JSON.stringify(confirmed.body)}`);
  }

  const devices =
    await admin.browser.get<{ id: string; userId: string; status: string }[]>('/api/devices');
  const pending = devices.body.find((d) => d.userId === person.id && d.status === 'pending');
  if (!pending) throw new Error('pending device not listed');
  const decision = await admin.browser.post(`/api/devices/${pending.id}/decision`, {
    decision: 'approve',
  });
  if (decision.status !== 200) throw new Error(`approval failed: ${JSON.stringify(decision.body)}`);

  env.clock.advance();
  await signIn(env, person);
  return person;
}

/** Password, then second factor, on the person's own browser. */
export async function signIn(
  env: TestEnv,
  person: Person,
): Promise<ApiResponse<{ status: string }>> {
  const first = await person.browser.post('/api/auth/login', {
    email: person.email,
    password: person.password,
  });
  if (first.status !== 200) throw new Error(`login failed: ${JSON.stringify(first.body)}`);
  const second = await person.browser.post<{ status: string }>('/api/auth/login/verify', {
    code: codeFor(env, person),
  });
  env.clock.advance();
  return second;
}

/** Makes the person's current session "stale": critical actions need the second factor again. */
export async function expireStepUp(env: TestEnv, person: Person): Promise<void> {
  await env.admin.query(
    `UPDATE auth.sessions SET step_up_at = now() - interval '2 hours'
     WHERE user_id = $1 AND revoked_at IS NULL`,
    [person.id],
  );
}
