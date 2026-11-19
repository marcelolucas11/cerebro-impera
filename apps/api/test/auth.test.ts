import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addPerson,
  Browser,
  codeFor,
  createTestEnv,
  expireStepUp,
  setUpOwner,
  signIn,
  STRONG_PASSWORD,
  type Person,
  type TestEnv,
} from './support/env.js';

interface ErrorBody {
  error: { code: string; details?: Record<string, unknown> };
}

let env: TestEnv;
let owner: Person;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('first-run setup', () => {
  it('is closed to anyone without the token from the server', async () => {
    const stranger = new Browser(env.app);
    const status = await stranger.get<{ needsSetup: boolean }>('/api/setup/status');
    expect(status.body.needsSetup).toBe(true);

    const attempt = await stranger.post<ErrorBody>('/api/setup/totp', {
      setupToken: 'x'.repeat(43),
      email: 'intruso@exemplo.test',
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.code).toBe('setup_closed');
  });

  it('rejects a weak owner password', async () => {
    const browser = new Browser(env.app);
    const setupToken = env.setupToken();
    const totp = await browser.post<{ secret: string }>('/api/setup/totp', {
      setupToken,
      email: 'dona@exemplo.test',
    });
    const attempt = await browser.post<ErrorBody>('/api/setup', {
      setupToken,
      instanceName: 'Empresa Exemplo',
      email: 'dona@exemplo.test',
      name: 'Dona Primeira',
      password: 'Password1234',
      totpSecret: totp.body.secret,
      totpCode: codeFor(env, { totpSecret: totp.body.secret }),
    });
    expect(attempt.status).toBe(400);
    expect(attempt.body.error.code).toBe('weak_password');
  });

  it('creates the first owner, signed in on an approved device', async () => {
    owner = await setUpOwner(env);
    const me = await owner.browser.get<{ user: { role: string }; instanceName: string }>('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('owner');
    expect(me.body.instanceName).toBe('Empresa Exemplo');
  });

  it('closes for good once completed', async () => {
    expect(existsSync(env.deps.config.setupTokenFile)).toBe(false);
    const again = await new Browser(env.app).post<ErrorBody>('/api/setup/totp', {
      setupToken: 'y'.repeat(43),
      email: 'outra@exemplo.test',
    });
    expect(again.status).toBe(403);
    const status = await new Browser(env.app).get<{ needsSetup: boolean }>('/api/setup/status');
    expect(status.body.needsSetup).toBe(false);
  });
});

describe('sign-in', () => {
  it('gives the same answer for a wrong password and an unknown e-mail', async () => {
    const browser = new Browser(env.app);
    const wrong = await browser.post<ErrorBody>('/api/auth/login', {
      email: owner.email,
      password: 'not-the-right-password',
    });
    const unknown = await browser.post<ErrorBody>('/api/auth/login', {
      email: 'ninguem@exemplo.test',
      password: 'not-the-right-password',
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('needs the second factor: a password alone opens nothing', async () => {
    const browser = new Browser(env.app);
    const first = await browser.post<{ next: string }>('/api/auth/login', {
      email: owner.email,
      password: owner.password,
    });
    expect(first.body.next).toBe('totp');
    expect((await browser.get('/api/me')).status).toBe(401);

    const wrongCode = await browser.post<ErrorBody>('/api/auth/login/verify', { code: '000000' });
    expect(wrongCode.status).toBe(401);
    expect((await browser.get('/api/me')).status).toBe(401);
  });

  it('accepts each code only once', async () => {
    await owner.browser.post('/api/auth/logout');
    await owner.browser.post('/api/auth/login', { email: owner.email, password: owner.password });
    const code = codeFor(env, owner);
    const first = await owner.browser.post<{ status: string }>('/api/auth/login/verify', { code });
    expect(first.body.status).toBe('authenticated');

    // Same code, same 30-second window, from someone who was watching.
    const replay = new Browser(env.app);
    replay.cookies.set(
      '__Host-cerebro_device',
      owner.browser.cookies.get('__Host-cerebro_device') ?? '',
    );
    await replay.post('/api/auth/login', { email: owner.email, password: owner.password });
    const second = await replay.post<ErrorBody>('/api/auth/login/verify', { code });
    expect(second.status).toBe(401);
    env.clock.advance();
  });

  it('accepts a recovery code once, and tells the owners', async () => {
    const env2 = await createTestEnv();
    try {
      const browser = new Browser(env2.app);
      const setupToken = env2.setupToken();
      const totp = await browser.post<{ secret: string }>('/api/setup/totp', {
        setupToken,
        email: 'dona@exemplo.test',
      });
      const done = await browser.post<{ recoveryCodes: string[] }>('/api/setup', {
        setupToken,
        instanceName: 'Outra',
        email: 'dona@exemplo.test',
        name: 'Dona Primeira',
        password: STRONG_PASSWORD,
        totpSecret: totp.body.secret,
        totpCode: codeFor(env2, { totpSecret: totp.body.secret }),
      });
      const recoveryCode = done.body.recoveryCodes[0];
      expect(done.body.recoveryCodes).toHaveLength(10);

      // What is stored cannot be recomputed from the code alone: it is keyed
      // with the instance key, which is not in the database.
      const plain = Buffer.from((recoveryCode ?? '').replace('-', ''), 'utf8');
      const guessable = await env2.admin.query(
        `SELECT 1 FROM auth.recovery_codes
         WHERE code_hash IN (sha256($1::bytea), sha256(sha256($1::bytea)))`,
        [plain],
      );
      expect(guessable.rowCount).toBe(0);
      expect((await env2.admin.query('SELECT 1 FROM auth.recovery_codes')).rowCount).toBe(10);

      await browser.post('/api/auth/logout');
      await browser.post('/api/auth/login', {
        email: 'dona@exemplo.test',
        password: STRONG_PASSWORD,
      });
      const ok = await browser.post<{ status: string }>('/api/auth/login/verify', { recoveryCode });
      expect(ok.body.status).toBe('authenticated');

      await browser.post('/api/auth/logout');
      await browser.post('/api/auth/login', {
        email: 'dona@exemplo.test',
        password: STRONG_PASSWORD,
      });
      const reused = await browser.post('/api/auth/login/verify', { recoveryCode });
      expect(reused.status).toBe(401);

      const alerts = await env2.admin.query(
        `SELECT count(*)::int AS n FROM app.security_alerts WHERE kind = 'recovery_code_used'`,
      );
      expect(alerts.rows[0]).toEqual({ n: 1 });
    } finally {
      await env2.close();
    }
  });
});

describe('device approval', () => {
  it('gives no session to a new browser until someone with authority approves it', async () => {
    const laptop = new Browser(env.app);
    laptop.userAgent = 'new-laptop';
    await laptop.post('/api/auth/login', { email: owner.email, password: owner.password });
    const result = await laptop.post<{ status: string }>('/api/auth/login/verify', {
      code: codeFor(env, owner),
    });
    env.clock.advance();
    expect(result.body.status).toBe('device_pending');
    expect(laptop.cookies.has('__Host-cerebro_session')).toBe(false);
    expect((await laptop.get('/api/me')).status).toBe(401);
    expect((await laptop.get<{ status: string }>('/api/auth/device')).body.status).toBe('pending');

    // Signing in again changes nothing while the device is pending.
    await laptop.post('/api/auth/login', { email: owner.email, password: owner.password });
    const again = await laptop.post<{ status: string }>('/api/auth/login/verify', {
      code: codeFor(env, owner),
    });
    env.clock.advance();
    expect(again.body.status).toBe('device_pending');

    // The owner approves it from the device they already use.
    const devices =
      await owner.browser.get<{ id: string; status: string; userAgent: string }[]>('/api/devices');
    const pending = devices.body.filter((d) => d.status === 'pending');
    expect(pending).toHaveLength(1);
    const approved = await owner.browser.post(`/api/devices/${pending[0]?.id}/decision`, {
      decision: 'approve',
    });
    expect(approved.status).toBe(200);

    await laptop.post('/api/auth/login', { email: owner.email, password: owner.password });
    const final = await laptop.post<{ status: string }>('/api/auth/login/verify', {
      code: codeFor(env, owner),
    });
    env.clock.advance();
    expect(final.body.status).toBe('authenticated');
    expect((await laptop.get('/api/me')).status).toBe(200);

    // Revoking the device cuts its session immediately.
    await owner.browser.post(`/api/devices/${pending[0]?.id}/decision`, { decision: 'revoke' });
    expect((await laptop.get('/api/me')).status).toBe(401);
  });

  it('raises an alert for every device waiting for approval', async () => {
    const alerts = await owner.browser.get<{ kind: string }[]>('/api/alerts');
    expect(alerts.body.some((a) => a.kind === 'device_pending')).toBe(true);
  });
});

describe('invites', () => {
  let employee: Person;

  it('brings a new person in: invite, own password, own second factor, approved device', async () => {
    employee = await addPerson(env, owner, {
      email: 'ana@exemplo.test',
      name: 'Ana Souza',
      role: 'employee',
    });
    const me = await employee.browser.get<{ user: { role: string; email: string } }>('/api/me');
    expect(me.body.user).toMatchObject({ role: 'employee', email: 'ana@exemplo.test' });
  });

  it('works exactly once', async () => {
    const created = await owner.browser.post<{ invite: { token: string } }>('/api/users', {
      email: 'bruno@exemplo.test',
      name: 'Bruno Lima',
      role: 'employee',
    });
    const token = created.body.invite.token;

    const weak = await new Browser(env.app).post<ErrorBody>('/api/auth/invite/accept', {
      token,
      password: 'bruno-lima-2030', // gitleaks:allow (senha fictícia de teste)
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('weak_password');

    const first = await new Browser(env.app).post('/api/auth/invite/accept', {
      token,
      password: STRONG_PASSWORD,
    });
    expect(first.status).toBe(200);
    const second = await new Browser(env.app).post<ErrorBody>('/api/auth/invite/accept', {
      token,
      password: STRONG_PASSWORD,
    });
    expect(second.status).toBe(400);
    expect(second.body.error.code).toBe('invalid_invite');
  });

  it('stores only a digest of the link', async () => {
    const stored = await env.admin.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM auth.invites',
    );
    for (const row of stored.rows) expect(row.token_hash).toHaveLength(32);
  });

  it('resets access from scratch: new password, new second factor, old sessions gone', async () => {
    const reset = await owner.browser.post<{ token: string; kind: string }>(
      `/api/users/${employee.id}/invite`,
    );
    expect(reset.body.kind).toBe('reset');
    expect((await employee.browser.get('/api/me')).status).toBe(200);

    const newPassword = 'outra-frase-bem-comprida-91'; // gitleaks:allow (senha fictícia de teste)
    const accepted = await employee.browser.post('/api/auth/invite/accept', {
      token: reset.body.token,
      password: newPassword,
    });
    expect(accepted.status).toBe(200);
    // The old session died with the reset.
    expect((await employee.browser.get('/api/me')).status).toBe(401);

    const enrol = await employee.browser.post<{ secret: string }>('/api/auth/totp/enroll');
    employee.totpSecret = enrol.body.secret;
    employee.password = newPassword;
    const confirmed = await employee.browser.post<{ status: string }>('/api/auth/totp/confirm', {
      code: codeFor(env, employee),
    });
    env.clock.advance();
    // Same approved browser as before, so no new approval is needed.
    expect(confirmed.body.status).toBe('authenticated');

    const oldPassword = await new Browser(env.app).post('/api/auth/login', {
      email: employee.email,
      password: STRONG_PASSWORD,
    });
    expect(oldPassword.status).toBe(401);
  });
});

describe('brute force', () => {
  it('locks an account after repeated failures, without locking out the real person', async () => {
    const attacker = new Browser(env.app);
    let last = 0;
    for (let i = 0; i < 6; i += 1) {
      const attempt = await attacker.post('/api/auth/login', {
        email: owner.email,
        password: `guess-number-${i}-wrong`,
      });
      last = attempt.status;
    }
    expect(last).toBe(429);

    // Even the right password is refused from an unknown browser while locked.
    const rightButLocked = await attacker.post<ErrorBody>('/api/auth/login', {
      email: owner.email,
      password: owner.password,
    });
    expect(rightButLocked.status).toBe(429);
    expect(rightButLocked.headers['retry-after']).toBeDefined();

    // The owner, on the browser they always use, is not affected.
    await owner.browser.post('/api/auth/logout');
    const result = await signIn(env, owner);
    expect(result.body.status).toBe('authenticated');

    const alerts = await owner.browser.get<{ kind: string }[]>('/api/alerts');
    expect(alerts.body.some((a) => a.kind === 'login_lockout')).toBe(true);
  });

  it('locks an e-mail no one has exactly as a real one, so locking reveals nothing', async () => {
    const answers = async (email: string): Promise<{ status: number; body: unknown }[]> => {
      const prober = new Browser(env.app);
      const seen: { status: number; body: unknown }[] = [];
      for (let i = 0; i < 7; i += 1) {
        const attempt = await prober.post('/api/auth/login', {
          email,
          password: `palpite-${String(i)}-errado`,
        });
        seen.push({ status: attempt.status, body: attempt.body });
      }
      return seen;
    };
    // Start clean: the test before left the owner locked.
    await env.admin.query('DELETE FROM auth.throttle');
    const fake = await answers('ninguem.mesmo@exemplo.test');
    const real = await answers(owner.email);
    expect(fake.map((a) => a.status)).toEqual(real.map((a) => a.status));
    expect(fake.at(-1)).toEqual(real.at(-1));
    // The address typed is not kept in the clear.
    const keys = await env.admin.query<{ key: string }>(
      `SELECT key FROM auth.throttle WHERE key LIKE 'email:%'`,
    );
    expect(keys.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(keys.rows)).not.toContain('ninguem');
  });

  it('gives up on a sign-in attempt after five wrong codes', async () => {
    await env.admin.query('DELETE FROM auth.throttle');
    const browser = new Browser(env.app);
    await browser.post('/api/auth/login', { email: owner.email, password: owner.password });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await browser.post('/api/auth/login/verify', { code: '000000' })).status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    await env.admin.query('DELETE FROM auth.throttle');
    // The challenge is spent: even the correct code no longer works on it.
    const late = await browser.post<ErrorBody>('/api/auth/login/verify', {
      code: codeFor(env, owner),
    });
    expect(late.status).toBe(401);
    expect(late.body.error.code).toBe('challenge_required');
  });
});

describe('sessions', () => {
  it('end immediately when revoked or when the account is suspended', async () => {
    await env.admin.query('DELETE FROM auth.throttle');
    const carla = await addPerson(env, owner, {
      email: 'carla@exemplo.test',
      name: 'Carla Reis',
      role: 'employee',
    });
    expect((await carla.browser.get('/api/me')).status).toBe(200);

    const revoked = await owner.browser.post<{ revoked: number }>(
      `/api/users/${carla.id}/revoke-sessions`,
    );
    expect(revoked.body.revoked).toBe(1);
    expect((await carla.browser.get('/api/me')).status).toBe(401);

    await signIn(env, carla);
    expect((await carla.browser.get('/api/me')).status).toBe(200);
    const suspended = await owner.browser.patch(`/api/users/${carla.id}`, { status: 'suspended' });
    expect(suspended.status).toBe(200);
    expect((await carla.browser.get('/api/me')).status).toBe(401);

    const login = await carla.browser.post('/api/auth/login', {
      email: carla.email,
      password: carla.password,
    });
    expect(login.status).toBe(401);
  });

  it('expire after the configured idle time', async () => {
    const before = await owner.browser.get('/api/me');
    expect(before.status).toBe(200);
    await env.admin.query(
      `UPDATE auth.sessions SET last_seen_at = now() - interval '13 hours' WHERE user_id = $1`,
      [owner.id],
    );
    expect((await owner.browser.get('/api/me')).status).toBe(401);
    await signIn(env, owner);
  });

  it('need the second factor again for critical actions after a while', async () => {
    await expireStepUp(env, owner);
    const refused = await owner.browser.post<ErrorBody>('/api/users', {
      email: 'davi@exemplo.test',
      name: 'Davi Rocha',
      role: 'employee',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('step_up_required');

    const wrong = await owner.browser.post('/api/auth/step-up', { code: '000000' });
    expect(wrong.status).toBe(401);
    const confirmed = await owner.browser.post('/api/auth/step-up', { code: codeFor(env, owner) });
    env.clock.advance();
    expect(confirmed.status).toBe(200);

    const allowed = await owner.browser.post('/api/users', {
      email: 'davi@exemplo.test',
      name: 'Davi Rocha',
      role: 'employee',
    });
    expect(allowed.status).toBe(200);
  });
});

describe('requests from other origins', () => {
  it('are refused, including from sibling subdomains of the same domain', async () => {
    const cookie = [...owner.browser.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const forge = (headers: Record<string, string>) =>
      env.app.inject({
        method: 'POST',
        url: '/api/spaces',
        headers: { cookie, 'content-type': 'application/json', ...headers },
        payload: { name: 'forjado' },
      });

    expect((await forge({})).statusCode).toBe(403);
    expect((await forge({ origin: 'https://crm.exemplo.test' })).statusCode).toBe(403);
    expect((await forge({ origin: 'null' })).statusCode).toBe(403);
    expect(
      (await forge({ origin: 'https://cerebro.exemplo.test', 'sec-fetch-site': 'same-site' }))
        .statusCode,
    ).toBe(403);

    const read = await env.app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie, 'sec-fetch-site': 'same-site' },
    });
    expect(read.statusCode).toBe(403);

    const formPost = await env.app.inject({
      method: 'POST',
      url: '/api/spaces',
      headers: {
        cookie,
        origin: 'https://cerebro.exemplo.test',
        'content-type': 'text/plain',
      },
      payload: '{"name":"forjado"}',
    });
    expect(formPost.statusCode).toBe(415);
  });

  it('get hardened headers and host-only cookies', async () => {
    const browser = new Browser(env.app);
    const response = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://cerebro.exemplo.test' },
      payload: { email: owner.email, password: owner.password },
    });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('__Host-cerebro_challenge=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('Domain=');
    expect(browser.cookies.size).toBe(0);
  });

  it('cannot smuggle unknown fields into a request', async () => {
    const response = await owner.browser.post<ErrorBody>('/api/users', {
      email: 'eva@exemplo.test',
      name: 'Eva Dias',
      role: 'employee',
      status: 'active',
      id: '00000000-0000-4000-8000-000000000000',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_input');
  });
});
