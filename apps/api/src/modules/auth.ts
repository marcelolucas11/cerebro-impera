import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { checkPassword } from '@cerebro/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Actor } from '../actor.js';
import {
  digest,
  newRecoveryCodes,
  newToken,
  normalizeRecoveryCode,
  safeEqual,
} from '../crypto/tokens.js';
import { newTotpSecret, totpUri, verifyTotp } from '../crypto/totp.js';
import { inTransaction, one, run, sql, type Queryable, type Tx } from '../db.js';
import type { Deps } from '../deps.js';
import {
  CHALLENGE_COOKIE,
  clearCookie,
  DEVICE_COOKIE,
  readToken,
  SESSION_COOKIE,
  setCookie,
} from '../http/cookies.js';
import { badRequest, conflict, forbidden, unauthorized } from '../http/errors.js';
import { addressGroup } from '../http/proxy.js';
import { clientIp, userAgent } from '../http/request.js';
import {
  ACCOUNT_POLICY,
  assertNotLocked,
  clearFailures,
  IP_POLICY,
  registerFailure,
} from './throttle.js';

const CHALLENGE_TTL_SECONDS = 600;
const MAX_CHALLENGE_ATTEMPTS = 5;
/** Browsers cap cookie lifetime at about 400 days; the device cookie is renewed on use. */
const DEVICE_COOKIE_SECONDS = 400 * 24 * 3600;

export type LoginResult = { status: 'authenticated' } | { status: 'device_pending' };
export type SecondFactor = { code: string } | { recoveryCode: string };

interface DeviceRow {
  id: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ipKey(ip: string | null): string {
  return `ip:${addressGroup(ip)}`;
}

/**
 * Failures from a browser the person already uses are counted apart from
 * failures elsewhere. Someone hammering an account from the outside can lock
 * out other outsiders, but not the real person on their approved device.
 */
function accountKey(userId: string, device: DeviceRow | undefined): string {
  return device?.status === 'approved' ? `device:${device.id}` : `account:${userId}`;
}

/**
 * An e-mail no account has is counted as an account would be. Otherwise only real
 * e-mails would ever lock, and a few wrong passwords would tell which ones exist. Kept
 * as a keyed digest: the throttle table never holds the addresses people typed.
 */
function emailKey(deps: Deps, email: string): string {
  return `email:${deps.vault.mac('throttle', 'email', email.trim().toLowerCase()).toString('base64url')}`;
}

async function findDevice(
  db: Queryable,
  request: FastifyRequest,
  userId: string,
): Promise<DeviceRow | undefined> {
  const token = readToken(request, DEVICE_COOKIE);
  if (token === undefined) return undefined;
  return one<DeviceRow>(
    db,
    sql`SELECT id, status FROM auth.devices
        WHERE token_hash = sha256(${digest(token)}) AND user_id = ${userId}`,
  );
}

async function audit(
  db: Queryable,
  actor: string | null,
  ip: string | null,
  action: string,
  target: { type: string; id: string } | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await run(
    db,
    sql`SELECT audit.record_as(${actor}, ${ip}::inet, ${action}, ${target?.type ?? null},
                               ${target?.id ?? null}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

/** The three alerts the login service raises (the database takes no other from it). */
async function alert(
  db: Queryable,
  kind: 'login_lockout' | 'recovery_code_used' | 'device_pending',
  actor: string | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await run(
    db,
    sql`SELECT auth.raise_login_alert(${kind}, ${actor}, ${JSON.stringify(metadata)}::jsonb)`,
  );
}

/** Records a failed attempt in committed statements, then lets the caller refuse. */
async function failedAttempt(
  deps: Deps,
  attempt: { ip: string | null; userId?: string; accountKey?: string; reason: string },
): Promise<void> {
  const db = deps.pools.auth;
  await registerFailure(db, ipKey(attempt.ip), IP_POLICY);
  if (attempt.accountKey !== undefined) {
    const result = await registerFailure(db, attempt.accountKey, ACCOUNT_POLICY);
    if (result.failures === ACCOUNT_POLICY.threshold && attempt.userId !== undefined) {
      await alert(db, 'login_lockout', null, { user_id: attempt.userId });
    }
  }
  await audit(
    db,
    attempt.userId ?? null,
    attempt.ip,
    'login.failed',
    attempt.userId === undefined ? null : { type: 'user', id: attempt.userId },
    { reason: attempt.reason },
  );
}

interface Challenge {
  id: string;
  userId: string;
}

/**
 * The open challenge in this browser. `forEnrolment` asks for one made when an
 * invite or reset was just used: only that one may link an authenticator.
 */
async function loadChallenge(
  db: Queryable,
  request: FastifyRequest,
  forEnrolment = false,
): Promise<Challenge> {
  const token = readToken(request, CHALLENGE_COOKIE);
  if (token === undefined) throw unauthorized('challenge_required');
  const row = await one<{ id: string; user_id: string }>(
    db,
    sql`SELECT c.id, c.user_id FROM auth.login_challenges c
        JOIN app.users u ON u.id = c.user_id
        WHERE c.token_hash = sha256(${digest(token)})
          AND c.consumed_at IS NULL AND c.expires_at > now()
          AND c.attempts < ${MAX_CHALLENGE_ATTEMPTS} AND u.status = 'active'
          AND (NOT ${forEnrolment}::boolean OR c.enrol)`,
  );
  if (!row) throw unauthorized('challenge_required');
  return { id: row.id, userId: row.user_id };
}

/** Spends one of the challenge's attempts before any code is checked. */
async function spendAttempt(db: Queryable, challenge: Challenge): Promise<void> {
  const spent = await run(
    db,
    sql`UPDATE auth.login_challenges SET attempts = attempts + 1
        WHERE id = ${challenge.id} AND consumed_at IS NULL
          AND attempts < ${MAX_CHALLENGE_ATTEMPTS}`,
  );
  if (spent !== 1) throw unauthorized('challenge_required');
}

async function issueChallenge(
  db: Queryable,
  reply: FastifyReply,
  userId: string,
  ip: string | null,
  enrol = false,
): Promise<void> {
  const token = newToken();
  await run(
    db,
    sql`INSERT INTO auth.login_challenges (token_hash, user_id, expires_at, ip, enrol)
        VALUES (sha256(${digest(token)}), ${userId},
                now() + make_interval(secs => ${CHALLENGE_TTL_SECONDS}), ${ip}::inet,
                ${enrol})`,
  );
  setCookie(reply, CHALLENGE_COOKIE, token, CHALLENGE_TTL_SECONDS);
}

/**
 * Checks a time-based code or a recovery code. Both are single-use: the
 * UPDATE that claims them only succeeds for one request.
 */
async function checkSecondFactor(
  deps: Deps,
  userId: string,
  ip: string | null,
  input: SecondFactor,
): Promise<boolean> {
  const db = deps.pools.auth;
  if ('code' in input) {
    const totp = await one<{ secret_enc: Buffer; last_step: string }>(
      db,
      sql`SELECT secret_enc, last_step FROM auth.totp
          WHERE user_id = ${userId} AND confirmed_at IS NOT NULL`,
    );
    if (!totp) return false;
    const secret = deps.vault.open('totp', `totp:${userId}`, totp.secret_enc).toString('utf8');
    const step = verifyTotp(secret, input.code, Number(totp.last_step), deps.now());
    if (step === null) return false;
    const claimed = await run(
      db,
      sql`UPDATE auth.totp SET last_step = ${step}
          WHERE user_id = ${userId} AND last_step < ${step}`,
    );
    return claimed === 1;
  }

  const code = normalizeRecoveryCode(input.recoveryCode);
  const used = await run(
    db,
    sql`UPDATE auth.recovery_codes SET used_at = now()
        WHERE user_id = ${userId} AND code_hash = ${recoveryDigest(deps, userId, code)}
          AND used_at IS NULL`,
  );
  if (used !== 1) return false;
  await audit(db, userId, ip, 'recovery_code.used', { type: 'user', id: userId });
  await alert(db, 'recovery_code_used', userId, { user_id: userId });
  return true;
}

async function createSession(
  tx: Tx,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  deviceToken: string,
): Promise<string> {
  const token = newToken();
  const id = randomUUID();
  // The database opens it only on an approved device of this person, shown
  // that device's secret; it starts "stepped up" (the second factor was just
  // confirmed) and lasts what the installation allows.
  const opened = await one<{ hours: number }>(
    tx,
    sql`SELECT auth.open_session(${id}, ${userId}, ${digest(deviceToken)}, ${digest(token)},
                                 ${clientIp(request)}::inet, ${userAgent(request)}) AS hours`,
  );
  setCookie(reply, SESSION_COOKIE, token, (opened?.hours ?? 12) * 3600);
  return id;
}

/**
 * Last step of every sign-in: both factors are proven, now the device decides.
 * An approved device gets a session. Anything else is registered (or
 * re-submitted) for approval and the person waits; no session exists until
 * someone with authority approves it.
 */
async function finishLogin(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  challenge: Challenge,
): Promise<LoginResult> {
  const ip = clientIp(request);
  const userId = challenge.userId;

  return inTransaction(deps.pools.auth, async (tx) => {
    const consumed = await run(
      tx,
      sql`UPDATE auth.login_challenges SET consumed_at = now()
          WHERE id = ${challenge.id} AND consumed_at IS NULL`,
    );
    if (consumed !== 1) throw unauthorized('challenge_required');
    clearCookie(reply, CHALLENGE_COOKIE);

    const device = await findDevice(tx, request, userId);
    await clearFailures(tx, accountKey(userId, device));

    const deviceToken = readToken(request, DEVICE_COOKIE);
    if (device?.status === 'approved' && deviceToken !== undefined) {
      const sessionId = await createSession(tx, request, reply, userId, deviceToken);
      setCookie(reply, DEVICE_COOKIE, deviceToken, DEVICE_COOKIE_SECONDS); // renew
      await audit(tx, userId, ip, 'login.succeeded', { type: 'session', id: sessionId });
      return { status: 'authenticated' };
    }
    if (device?.status === 'pending') {
      return { status: 'device_pending' };
    }

    let deviceId: string;
    if (device) {
      // Previously rejected or revoked: ask again, keeping the same record.
      deviceId = device.id;
      await run(
        tx,
        sql`UPDATE auth.devices
            SET status = 'pending', decided_by = NULL, decided_at = NULL, created_at = now(),
                created_ip = ${ip}::inet, user_agent = ${userAgent(request)}
            WHERE id = ${device.id}`,
      );
    } else {
      // A browser shared by two people keeps one cookie and gets one record each.
      const token = readToken(request, DEVICE_COOKIE) ?? newToken();
      deviceId = randomUUID();
      await run(
        tx,
        sql`INSERT INTO auth.devices (id, user_id, token_hash, user_agent, created_ip)
            VALUES (${deviceId}, ${userId}, sha256(${digest(token)}), ${userAgent(request)},
                    ${ip}::inet)`,
      );
      setCookie(reply, DEVICE_COOKIE, token, DEVICE_COOKIE_SECONDS);
    }
    await audit(tx, userId, ip, 'device.pending', { type: 'device', id: deviceId });
    await alert(tx, 'device_pending', userId, { device_id: deviceId, user_id: userId });
    return { status: 'device_pending' };
  });
}

// ---------------------------------------------------------------------------
// First-run setup
// ---------------------------------------------------------------------------

export async function setupStatus(
  deps: Deps,
): Promise<{ needsSetup: boolean; instanceName: string }> {
  const row = await one<{ instance_name: string; done: boolean }>(
    deps.pools.auth,
    sql`SELECT instance_name, setup_completed_at IS NOT NULL AS done FROM app.instance_settings`,
  );
  return { needsSetup: !(row?.done ?? false), instanceName: row?.instance_name ?? '' };
}

/**
 * While the instance has no owner, a one-time token is kept in the config
 * directory. Whoever installs the server reads it there; without it, nobody
 * on the internet can claim a freshly installed instance.
 */
export async function ensureSetupToken(deps: Deps): Promise<{ pending: boolean }> {
  const { needsSetup } = await setupStatus(deps);
  const file = deps.config.setupTokenFile;
  if (!needsSetup) {
    rmSync(file, { force: true });
    return { pending: false };
  }
  if (!existsSync(file)) {
    writeFileSync(file, `${newToken()}\n`, { mode: 0o600, flag: 'wx' });
  }
  return { pending: true };
}

function assertSetupToken(deps: Deps, provided: string): void {
  let expected: string;
  try {
    expected = readFileSync(deps.config.setupTokenFile, 'utf8').trim();
  } catch {
    throw forbidden('setup_closed');
  }
  if (expected.length < 20 || !safeEqual(expected, provided)) throw forbidden('setup_closed');
}

export async function setupTotp(
  deps: Deps,
  request: FastifyRequest,
  body: { setupToken: string; email: string },
): Promise<{ secret: string; otpauthUri: string }> {
  await assertNotLocked(deps.pools.auth, ipKey(clientIp(request)));
  try {
    assertSetupToken(deps, body.setupToken);
  } catch (error) {
    await registerFailure(deps.pools.auth, ipKey(clientIp(request)), IP_POLICY);
    throw error;
  }
  const { needsSetup, instanceName } = await setupStatus(deps);
  if (!needsSetup) throw forbidden('setup_closed');
  const secret = newTotpSecret();
  return { secret, otpauthUri: totpUri(secret, instanceName, body.email) };
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

/**
 * Creates the first owner in a single transaction: account, password, second
 * factor, recovery codes, this browser as an approved device, and a session.
 * Either all of it exists afterwards or none of it does.
 */
export async function completeSetup(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  body: SetupInput,
): Promise<{ recoveryCodes: string[] }> {
  const ip = clientIp(request);
  await assertNotLocked(deps.pools.auth, ipKey(ip));
  try {
    assertSetupToken(deps, body.setupToken);
  } catch (error) {
    await registerFailure(deps.pools.auth, ipKey(ip), IP_POLICY);
    throw error;
  }

  const problems = checkPassword(body.password, { email: body.email, name: body.name });
  if (problems.length > 0) throw badRequest('weak_password', { problems });
  const step = verifyTotp(body.totpSecret, body.totpCode, 0, deps.now());
  if (step === null) throw badRequest('invalid_code');

  const passwordHash = await deps.hasher.hash(body.password);
  const userId = randomUUID();
  const deviceId = randomUUID();
  const deviceToken = newToken();
  const recoveryCodes = newRecoveryCodes();

  await inTransaction(deps.pools.auth, async (tx) => {
    // Locking the settings row makes concurrent setups queue up; the loser
    // then sees setup already completed.
    const open = await one<{ id: boolean }>(
      tx,
      sql`SELECT id FROM app.instance_settings WHERE setup_completed_at IS NULL FOR UPDATE`,
    );
    if (!open) throw forbidden('setup_closed');

    await run(
      tx,
      sql`INSERT INTO app.users (id, email, name, role, status)
          VALUES (${userId}, ${body.email}, ${body.name}, 'owner', 'active')`,
    );
    await run(
      tx,
      sql`INSERT INTO auth.credentials (user_id, password_hash) VALUES (${userId}, ${passwordHash})`,
    );
    const sealed = deps.vault.seal('totp', `totp:${userId}`, Buffer.from(body.totpSecret, 'utf8'));
    await run(
      tx,
      sql`INSERT INTO auth.totp (user_id, secret_enc, confirmed_at, last_step)
          VALUES (${userId}, ${sealed}, now(), ${step})`,
    );
    await storeRecoveryCodes(deps, tx, userId, recoveryCodes);
    await run(
      tx,
      sql`INSERT INTO auth.devices (id, user_id, token_hash, user_agent, status, created_ip,
                                    decided_by, decided_at)
          VALUES (${deviceId}, ${userId}, sha256(${digest(deviceToken)}), ${userAgent(request)},
                  'approved', ${ip}::inet, ${userId}, now())`,
    );
    await run(
      tx,
      sql`UPDATE app.instance_settings
          SET instance_name = ${body.instanceName}, setup_completed_at = now()`,
    );
    await createSession(tx, request, reply, userId, deviceToken);
    await audit(tx, userId, ip, 'instance.setup_completed', { type: 'user', id: userId });
  });

  setCookie(reply, DEVICE_COOKIE, deviceToken, DEVICE_COOKIE_SECONDS);
  rmSync(deps.config.setupTokenFile, { force: true });
  return { recoveryCodes };
}

/**
 * Recovery codes are short enough to guess offline, so what is stored is a
 * digest keyed with the instance key and tied to the person: useless to
 * someone who only has a copy of the database.
 */
function recoveryDigest(deps: Deps, userId: string, normalizedCode: string): Buffer {
  return deps.vault.mac('recovery-code', userId, normalizedCode);
}

async function storeRecoveryCodes(
  deps: Deps,
  tx: Tx,
  userId: string,
  codes: string[],
): Promise<void> {
  await run(tx, sql`DELETE FROM auth.recovery_codes WHERE user_id = ${userId}`);
  for (const code of codes) {
    await run(
      tx,
      sql`INSERT INTO auth.recovery_codes (user_id, code_hash)
          VALUES (${userId}, ${recoveryDigest(deps, userId, normalizeRecoveryCode(code))})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

export async function login(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  body: { email: string; password: string },
): Promise<{ next: 'totp' }> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  await assertNotLocked(db, ipKey(ip));

  const user = await one<{ id: string; status: string; password_hash: string | null }>(
    db,
    sql`SELECT u.id, u.status, c.password_hash
        FROM app.users u LEFT JOIN auth.credentials c ON c.user_id = u.id
        WHERE u.email = ${body.email}`,
  );
  const device = user ? await findDevice(db, request, user.id) : undefined;
  const key = user ? accountKey(user.id, device) : emailKey(deps, body.email);
  await assertNotLocked(db, key);

  let passwordOk = false;
  if (user && user.password_hash !== null && user.status === 'active') {
    passwordOk = await deps.hasher.verify(user.password_hash, body.password);
  } else {
    // Unknown, invited or suspended account: do the same amount of work.
    await deps.hasher.burn(body.password);
  }

  if (!user || !passwordOk) {
    await failedAttempt(deps, {
      ip,
      reason: 'password',
      ...(user ? { userId: user.id } : {}),
      accountKey: key,
    });
    // One message for every cause, so nothing reveals which e-mails exist.
    throw unauthorized('invalid_credentials');
  }

  const enrolled = await one<{ ok: number }>(
    db,
    sql`SELECT 1 AS ok FROM auth.totp WHERE user_id = ${user.id} AND confirmed_at IS NOT NULL`,
  );
  // An authenticator is linked only right after an invite or reset is used, never
  // with the password alone: whoever stopped halfway asks for a new link.
  if (!enrolled) throw unauthorized('authenticator_missing');
  await issueChallenge(db, reply, user.id, ip);
  return { next: 'totp' };
}

export async function verifySecondFactor(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  input: SecondFactor,
): Promise<LoginResult> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  await assertNotLocked(db, ipKey(ip));
  const challenge = await loadChallenge(db, request);
  const device = await findDevice(db, request, challenge.userId);
  const key = accountKey(challenge.userId, device);
  await assertNotLocked(db, key);
  await spendAttempt(db, challenge);

  if (!(await checkSecondFactor(deps, challenge.userId, ip, input))) {
    await failedAttempt(deps, {
      ip,
      userId: challenge.userId,
      accountKey: key,
      reason: 'second_factor',
    });
    throw unauthorized('invalid_code');
  }
  return finishLogin(deps, request, reply, challenge);
}

// ---------------------------------------------------------------------------
// Second-factor enrolment (first sign-in after an invite or a reset)
// ---------------------------------------------------------------------------

export async function enrollStart(
  deps: Deps,
  request: FastifyRequest,
): Promise<{ secret: string; otpauthUri: string }> {
  const db = deps.pools.auth;
  const challenge = await loadChallenge(db, request, true);
  const context = await one<{ email: string; instance_name: string; enrolled: boolean }>(
    db,
    sql`SELECT u.email, i.instance_name,
               EXISTS (SELECT 1 FROM auth.totp t
                       WHERE t.user_id = u.id AND t.confirmed_at IS NOT NULL) AS enrolled
        FROM app.users u CROSS JOIN app.instance_settings i WHERE u.id = ${challenge.userId}`,
  );
  if (!context) throw unauthorized('challenge_required');
  if (context.enrolled) throw conflict('totp_already_enrolled');

  const secret = newTotpSecret();
  const sealed = deps.vault.seal('totp', `totp:${challenge.userId}`, Buffer.from(secret, 'utf8'));
  await run(
    db,
    sql`INSERT INTO auth.totp (user_id, secret_enc) VALUES (${challenge.userId}, ${sealed})
        ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, created_at = now()
        WHERE auth.totp.confirmed_at IS NULL`,
  );
  return { secret, otpauthUri: totpUri(secret, context.instance_name, context.email) };
}

export async function enrollConfirm(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  body: { code: string },
): Promise<LoginResult & { recoveryCodes: string[] }> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  await assertNotLocked(db, ipKey(ip));
  const challenge = await loadChallenge(db, request, true);
  await spendAttempt(db, challenge);

  const pending = await one<{ secret_enc: Buffer }>(
    db,
    sql`SELECT secret_enc FROM auth.totp
        WHERE user_id = ${challenge.userId} AND confirmed_at IS NULL`,
  );
  if (!pending) throw conflict('totp_not_pending');
  const secret = deps.vault
    .open('totp', `totp:${challenge.userId}`, pending.secret_enc)
    .toString('utf8');
  const step = verifyTotp(secret, body.code, 0, deps.now());
  if (step === null) {
    await failedAttempt(deps, { ip, userId: challenge.userId, reason: 'totp_enrolment' });
    throw unauthorized('invalid_code');
  }

  const recoveryCodes = newRecoveryCodes();
  await inTransaction(db, async (tx) => {
    const confirmed = await run(
      tx,
      sql`UPDATE auth.totp SET confirmed_at = now(), last_step = ${step}
          WHERE user_id = ${challenge.userId} AND confirmed_at IS NULL`,
    );
    if (confirmed !== 1) throw conflict('totp_not_pending');
    await storeRecoveryCodes(deps, tx, challenge.userId, recoveryCodes);
    await audit(tx, challenge.userId, ip, 'totp.enrolled', {
      type: 'user',
      id: challenge.userId,
    });
  });

  const result = await finishLogin(deps, request, reply, challenge);
  return { ...result, recoveryCodes };
}

// ---------------------------------------------------------------------------
// Invites and access resets
// ---------------------------------------------------------------------------

export async function acceptInvite(
  deps: Deps,
  request: FastifyRequest,
  reply: FastifyReply,
  body: { token: string; password: string },
): Promise<{ next: 'enroll_totp' }> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  await assertNotLocked(db, ipKey(ip));

  const invite = await one<{
    id: string;
    kind: 'invite' | 'reset';
    user_id: string;
    email: string;
    name: string;
    status: string;
  }>(
    db,
    sql`SELECT i.id, i.kind, i.user_id, u.email, u.name, u.status
        FROM auth.invites i JOIN app.users u ON u.id = i.user_id
        WHERE i.token_hash = sha256(${digest(body.token)})
          AND i.used_at IS NULL AND i.expires_at > now()`,
  );
  const expectedStatus = invite?.kind === 'invite' ? 'invited' : 'active';
  if (!invite || invite.status !== expectedStatus) {
    await registerFailure(db, ipKey(ip), IP_POLICY);
    throw badRequest('invalid_invite');
  }

  const problems = checkPassword(body.password, { email: invite.email, name: invite.name });
  if (problems.length > 0) throw badRequest('weak_password', { problems });
  const passwordHash = await deps.hasher.hash(body.password);

  await inTransaction(db, async (tx) => {
    const claimed = await run(
      tx,
      sql`UPDATE auth.invites SET used_at = now() WHERE id = ${invite.id} AND used_at IS NULL`,
    );
    if (claimed !== 1) throw badRequest('invalid_invite');

    await run(
      tx,
      sql`INSERT INTO auth.credentials (user_id, password_hash)
          VALUES (${invite.user_id}, ${passwordHash})
          ON CONFLICT (user_id) DO UPDATE
            SET password_hash = EXCLUDED.password_hash, password_changed_at = now()`,
    );
    if (invite.kind === 'invite') {
      await run(
        tx,
        sql`UPDATE app.users SET status = 'active'
            WHERE id = ${invite.user_id} AND status = 'invited'`,
      );
    }
    // Whatever second factor and sessions existed before are void: a reset
    // starts the person from a clean slate.
    await run(tx, sql`DELETE FROM auth.totp WHERE user_id = ${invite.user_id}`);
    await run(tx, sql`DELETE FROM auth.recovery_codes WHERE user_id = ${invite.user_id}`);
    await run(
      tx,
      sql`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'access reset'
          WHERE user_id = ${invite.user_id} AND revoked_at IS NULL`,
    );
    await issueChallenge(tx, reply, invite.user_id, ip, true);
    await audit(
      tx,
      invite.user_id,
      ip,
      'invite.accepted',
      { type: 'user', id: invite.user_id },
      {
        kind: invite.kind,
      },
    );
  });
  return { next: 'enroll_totp' };
}

// ---------------------------------------------------------------------------
// Signed-in operations that touch credentials
// ---------------------------------------------------------------------------

/** Confirms the second factor again; unlocks critical actions for a few minutes. */
export async function stepUp(
  deps: Deps,
  request: FastifyRequest,
  actor: Actor,
  body: { code: string },
): Promise<void> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  const key = `device:${actor.deviceId}`;
  await assertNotLocked(db, key);

  if (!(await checkSecondFactor(deps, actor.userId, ip, body))) {
    await failedAttempt(deps, { ip, userId: actor.userId, accountKey: key, reason: 'step_up' });
    throw unauthorized('invalid_code');
  }
  await run(
    db,
    sql`UPDATE auth.sessions SET step_up_at = now()
        WHERE id = ${actor.sessionId} AND revoked_at IS NULL`,
  );
  await clearFailures(db, key);
  await audit(db, actor.userId, ip, 'session.step_up', { type: 'session', id: actor.sessionId });
}

/**
 * Changes the signed-in person's own password. Takes the current password and
 * a fresh code from the authenticator; failures count towards locking this
 * device out. Every other session of the person ends: whoever might have had
 * the old password is out.
 */
export async function changePassword(
  deps: Deps,
  request: FastifyRequest,
  actor: Actor,
  body: { currentPassword: string; newPassword: string; code: string },
): Promise<{ endedSessions: number }> {
  const db = deps.pools.auth;
  const ip = clientIp(request);
  const key = `device:${actor.deviceId}`;
  await assertNotLocked(db, key);

  const stored = await one<{ password_hash: string }>(
    db,
    sql`SELECT password_hash FROM auth.credentials WHERE user_id = ${actor.userId}`,
  );
  let passwordOk = false;
  if (stored) {
    passwordOk = await deps.hasher.verify(stored.password_hash, body.currentPassword);
  } else {
    await deps.hasher.burn(body.currentPassword);
  }
  // The code is only spent once the password is right, so a wrong guess costs no code.
  if (
    !passwordOk ||
    !stored ||
    !(await checkSecondFactor(deps, actor.userId, ip, { code: body.code }))
  ) {
    await failedAttempt(deps, {
      ip,
      userId: actor.userId,
      accountKey: key,
      reason: 'password_change',
    });
    throw unauthorized('invalid_credentials');
  }

  const problems = checkPassword(body.newPassword, { email: actor.email, name: actor.name });
  if (problems.length > 0) throw badRequest('weak_password', { problems });
  if (await deps.hasher.verify(stored.password_hash, body.newPassword)) {
    throw badRequest('same_password');
  }
  const passwordHash = await deps.hasher.hash(body.newPassword);

  const endedSessions = await inTransaction(db, async (tx) => {
    await run(
      tx,
      sql`UPDATE auth.credentials SET password_hash = ${passwordHash}, password_changed_at = now()
          WHERE user_id = ${actor.userId}`,
    );
    const ended = await run(
      tx,
      sql`UPDATE auth.sessions SET revoked_at = now(), revoked_reason = 'password changed'
          WHERE user_id = ${actor.userId} AND id <> ${actor.sessionId} AND revoked_at IS NULL`,
    );
    await audit(
      tx,
      actor.userId,
      ip,
      'password.changed',
      { type: 'user', id: actor.userId },
      { endedSessions: ended },
    );
    return ended;
  });
  await clearFailures(db, key);
  return { endedSessions };
}

/** What the "waiting for approval" screen polls. Reveals nothing but a status. */
export async function deviceStatus(
  deps: Deps,
  request: FastifyRequest,
): Promise<{ status: DeviceRow['status'] | 'unknown' }> {
  const token = readToken(request, DEVICE_COOKIE);
  if (token === undefined) return { status: 'unknown' };
  const row = await one<{ status: DeviceRow['status'] }>(
    deps.pools.auth,
    sql`SELECT status FROM auth.devices WHERE token_hash = sha256(${digest(token)})
        ORDER BY created_at DESC LIMIT 1`,
  );
  return { status: row?.status ?? 'unknown' };
}
