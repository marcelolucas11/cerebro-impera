import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS_ALLOWANCE } from '../src/app.js';
import {
  DEFAULT_REQUESTS_PER_MINUTE,
  parseRequestsPerMinute,
  parseTrustProxy,
} from '../src/config.js';
import { addressGroup, trustHops } from '../src/http/proxy.js';
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

  it('caps each address, so made-up session cookies do not open fresh allowances', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT * ADDRESS_ALLOWANCE + 5; i += 1) {
      const response = await env.app.inject({
        method: 'GET',
        url: '/api/setup/status',
        headers: { cookie: `__Host-cerebro_session=${randomBytes(32).toString('base64url')}` },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.filter((status) => status === 200).length).toBeLessThanOrEqual(
      LIMIT * ADDRESS_ALLOWANCE,
    );
    expect(statuses.at(-1)).toBe(429);
  });

  it('counts one IPv6 network as one before anyone signs in, whatever address of it is used', async () => {
    const statuses: number[] = [];
    for (let n = 1; n <= LIMIT + 1; n += 1) {
      const response = await env.app.inject({
        method: 'GET',
        url: '/api/setup/status',
        remoteAddress: `2001:db8:5:6::${n.toString(16)}`,
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, LIMIT).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('believes only the proxies in front, never an address the client wrote', async () => {
    expect(parseTrustProxy(undefined)).toBe(0);
    expect(parseTrustProxy('false')).toBe(0);
    expect(parseTrustProxy('true')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
    for (const bad of ['sim', '-1', '9', '1.5']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/CEREBRO_TRUST_PROXY/);
    }
    const probe = Fastify({ trustProxy: trustHops(1) });
    probe.get('/', (request) => ({ ip: request.ip }));
    // The client wrote the first address; the proxy appended the one it saw.
    const seen = await probe.inject({
      method: 'GET',
      url: '/',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });
    expect(seen.json()).toEqual({ ip: '198.51.100.7' });
    await probe.close();

    // One IPv6 subscriber holds a whole /64: it counts as one.
    expect(addressGroup('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0db8:0001:0002:ffff:1:2:3')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(addressGroup('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressGroup('203.0.113.9')).toBe('203.0.113.9');
    expect(addressGroup(null)).toBe('unknown');
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
