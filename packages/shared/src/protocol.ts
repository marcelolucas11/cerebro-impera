import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/*
 * How the API and the updater talk: over an internal network, every request
 * signed with a key only the two of them have (made by `init-secrets`), with
 * the time and a one-time number, so a request cannot be forged, changed or
 * replayed. The updater refuses anything older than a minute or seen before.
 */

export const SIGNATURE_WINDOW_MS = 60_000;

export interface SignedHeaders {
  'x-cerebro-time': string;
  'x-cerebro-nonce': string;
  'x-cerebro-signature': string;
}

function canonical(
  method: string,
  path: string,
  time: string,
  nonce: string,
  body: string,
): string {
  const digest = createHash('sha256').update(body).digest('base64url');
  return [method.toUpperCase(), path, time, nonce, digest].join('\n');
}

export function sign(
  key: Buffer,
  request: { method: string; path: string; body: string; time: number; nonce: string },
): SignedHeaders {
  const time = String(request.time);
  return {
    'x-cerebro-time': time,
    'x-cerebro-nonce': request.nonce,
    'x-cerebro-signature': createHmac('sha256', key)
      .update(canonical(request.method, request.path, time, request.nonce, request.body))
      .digest('base64url'),
  };
}

/** Whether a request carries a valid signature made within the window. Nonces are the caller's to remember. */
export function verify(
  key: Buffer,
  request: { method: string; path: string; body: string; headers: Partial<SignedHeaders> },
  now: number,
): boolean {
  const time = request.headers['x-cerebro-time'];
  const nonce = request.headers['x-cerebro-nonce'];
  const given = request.headers['x-cerebro-signature'];
  if (time === undefined || nonce === undefined || given === undefined) return false;
  if (!/^\d{13}$/.test(time) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return false;
  if (Math.abs(now - Number(time)) > SIGNATURE_WINDOW_MS) return false;
  const expected = createHmac('sha256', key)
    .update(canonical(request.method, request.path, time, nonce, request.body))
    .digest();
  const provided = Buffer.from(given, 'base64url');
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** What the updater says about the installation. Versions are "1.2.3". */
export interface UpdaterStatus {
  current: string;
  checkedAt: string | null;
  available: { version: string; publishedAt: string; notes: string } | null;
  job: {
    id: string;
    from: string;
    to: string;
    state: 'running' | 'applied' | 'rolled_back' | 'failed';
    /** backup, verify, download, migrate, start, health, rollback */
    step: string;
    startedAt: string;
    finishedAt: string | null;
    /** In words the page can show, when it went wrong. */
    problem: string | null;
  } | null;
}

/** A refusal from the updater: a stable code, never a stack trace. */
export class UpdaterRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
