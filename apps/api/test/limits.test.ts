import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_REQUESTS_PER_MINUTE, parseRequestsPerMinute } from '../src/config.js';
import { LIVE_OPENS_PER_MINUTE } from '../src/live.js';
import { Browser, createTestEnv, setUpOwner, type Person, type TestEnv } from './support/env.js';

/*
 * How many requests one session may make: every route is limited, counted per
 * session (or per address before signing in), and the stream of live updates
 * more tightly than the rest.
 */

interface ErrorBody {
  error: { code: string; details?: { retryAfterSeconds?: number } };
}

const LIMIT = 60;
let env: TestEnv;
let owner: Person;

beforeAll(async () => {
  env = await createTestEnv({ requestsPerMinute: LIMIT });
  owner = await setUpOwner(env);
});
afterAll(async () => {
  await env.close();
});

describe('limits on requests', () => {
  it('stops a session that makes too many, and only that session', async () => {
    const statuses: number[] = [];
    let last: { status: number; body: ErrorBody; headers: Record<string, unknown> } | undefined;
    for (let i = 0; i < LIMIT + 5; i += 1) {
      last = await owner.browser.get<ErrorBody>('/api/me');
      statuses.push(last.status);
    }
    expect(statuses).toContain(200);
    expect(statuses.at(-1)).toBe(429);
    expect(last?.body.error.code).toBe('too_many_requests');
    const wait = last?.body.error.details?.retryAfterSeconds ?? 0;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
    expect(last?.headers['retry-after']).toBe(String(wait));

    // Someone else, here not signed in, still gets through.
    const stranger = new Browser(env.app);
    expect((await stranger.get('/api/setup/status')).status).toBe(200);
  });

  it('allows fewer openings of the live stream than other requests', async () => {
    const stranger = new Browser(env.app);
    stranger.userAgent = 'outro-navegador';
    const statuses: number[] = [];
    for (let i = 0; i <= LIVE_OPENS_PER_MINUTE; i += 1) {
      statuses.push((await stranger.get('/api/events')).status);
    }
    expect(statuses.slice(0, LIVE_OPENS_PER_MINUTE).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('is set by the installation, within sensible bounds', () => {
    expect(parseRequestsPerMinute(undefined)).toBe(DEFAULT_REQUESTS_PER_MINUTE);
    expect(parseRequestsPerMinute('')).toBe(DEFAULT_REQUESTS_PER_MINUTE);
    expect(parseRequestsPerMinute('1200')).toBe(1200);
    for (const bad of ['59', '100001', '1.5', 'muitos']) {
      expect(() => parseRequestsPerMinute(bad), bad).toThrow(/CEREBRO_REQUESTS_PER_MINUTE/);
    }
  });
});
