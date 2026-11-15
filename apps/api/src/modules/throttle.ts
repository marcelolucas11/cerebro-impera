import { one, run, sql, type Queryable } from '../db.js';
import { tooManyAttempts } from '../http/errors.js';

export interface ThrottlePolicy {
  /** Failures tolerated before the first lock. */
  threshold: number;
  /** First lock duration; doubles with each further failure. */
  baseSeconds: number;
  maxSeconds: number;
}

/** Per account (or per approved device): 5 misses, then 30 s, 1 min, 2 min... up to 15 min. */
export const ACCOUNT_POLICY: ThrottlePolicy = { threshold: 5, baseSeconds: 30, maxSeconds: 900 };
/** Per address, across all accounts: slows down password spraying. */
export const IP_POLICY: ThrottlePolicy = { threshold: 20, baseSeconds: 60, maxSeconds: 900 };

/** Throws 429 while the key is locked. */
export async function assertNotLocked(db: Queryable, key: string): Promise<void> {
  const row = await one<{ seconds: number }>(
    db,
    sql`SELECT ceil(extract(epoch FROM locked_until - now()))::int AS seconds
        FROM auth.throttle WHERE key = ${key} AND locked_until > now()`,
  );
  if (row) throw tooManyAttempts(Math.max(1, row.seconds));
}

/**
 * Counts a failure. Must run outside any transaction that is about to be
 * rolled back, otherwise the failure would be forgotten.
 */
export async function registerFailure(
  db: Queryable,
  key: string,
  policy: ThrottlePolicy,
): Promise<{ failures: number; lockedSeconds: number }> {
  const row = await one<{ failures: number }>(
    db,
    sql`INSERT INTO auth.throttle AS t (key, failures) VALUES (${key}, 1)
        ON CONFLICT (key) DO UPDATE SET
          failures = CASE WHEN t.last_failure_at < now() - interval '60 minutes' THEN 1
                          ELSE t.failures + 1 END,
          first_failure_at = CASE WHEN t.last_failure_at < now() - interval '60 minutes' THEN now()
                                  ELSE t.first_failure_at END,
          last_failure_at = now()
        RETURNING failures`,
  );
  const failures = row?.failures ?? 1;
  if (failures < policy.threshold) return { failures, lockedSeconds: 0 };

  const doublings = Math.min(failures - policy.threshold, 20);
  const lockedSeconds = Math.min(policy.baseSeconds * 2 ** doublings, policy.maxSeconds);
  await run(
    db,
    sql`UPDATE auth.throttle SET locked_until = now() + make_interval(secs => ${lockedSeconds})
        WHERE key = ${key}`,
  );
  return { failures, lockedSeconds };
}

export async function clearFailures(db: Queryable, key: string): Promise<void> {
  await run(db, sql`DELETE FROM auth.throttle WHERE key = ${key}`);
}
