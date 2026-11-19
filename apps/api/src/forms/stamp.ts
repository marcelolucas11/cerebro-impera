import { createHmac, timingSafeEqual } from 'node:crypto';

/*
 * The stamp a form page carries: when it was handed out, signed with the
 * service's key. A robot that posts straight away, or replays an old page, is
 * told apart from a person who read the questions. It is not a secret and
 * proves nothing about who sends; it only slows down the laziest abuse.
 */

/** A person takes at least this long to read and fill in even one question. */
export const MIN_FILL_MS = 3_000;
/** A page left open longer than this is handed out again before sending. */
export const MAX_FILL_MS = 6 * 60 * 60 * 1000;

function signature(key: Buffer, slug: string, issuedAt: number): string {
  return createHmac('sha256', key)
    .update(`${slug}\n${String(issuedAt)}`)
    .digest('base64url');
}

export function issueStamp(key: Buffer, slug: string, now: number): string {
  return `${String(now)}.${signature(key, slug, now)}`;
}

export type StampCheck = 'ok' | 'too_fast' | 'expired' | 'invalid';

export function checkStamp(key: Buffer, slug: string, stamp: string, now: number): StampCheck {
  const match = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(stamp);
  if (!match) return 'invalid';
  const issuedAt = Number(match[1]);
  const given = Buffer.from(match[2] ?? '');
  const expected = Buffer.from(signature(key, slug, issuedAt));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
  if (now - issuedAt < MIN_FILL_MS) return now < issuedAt ? 'invalid' : 'too_fast';
  if (now - issuedAt > MAX_FILL_MS) return 'expired';
  return 'ok';
}
