import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpUpdater, UpdaterUnreachable, type Updater } from '../src/updates/client.js';
import { sign, UpdaterRefusal, verify, type UpdaterStatus } from '../src/updates/protocol.js';
import { createTestEnv, expireStepUp, type Person, type TestEnv } from './support/env.js';
import { buildScenario, type Scenario } from './support/scenario.js';

/*
 * Updates: only owners see them; applying one asks for the code again; what is
 * asked of the updater and what comes of it goes on the record. The updater is
 * on the other side of an internal network, every request signed.
 */

class FakeUpdater implements Updater {
  reachable = true;
  refuse: string | null = null;
  state: UpdaterStatus = { current: '1.4.0', checkedAt: null, available: null, job: null };
  asked: string[] = [];
  private answer(what: string): Promise<UpdaterStatus> {
    this.asked.push(what);
    if (!this.reachable) return Promise.reject(new UpdaterUnreachable());
    return Promise.resolve(structuredClone(this.state));
  }
  status(): Promise<UpdaterStatus> {
    return this.answer('status');
  }
  check(): Promise<UpdaterStatus> {
    this.state.checkedAt = '2030-01-01T12:00:00.000Z';
    this.state.available = {
      version: '1.5.0',
      publishedAt: '2029-12-30T10:00:00.000Z',
      notes: 'Correções. <script>nada</script>',
    };
    return this.answer('check');
  }
  apply(version: string): Promise<UpdaterStatus> {
    if (this.refuse !== null) return Promise.reject(new UpdaterRefusal(this.refuse));
    this.state.job = {
      id: '7a4c1b2e-0000-4000-8000-000000000001',
      from: this.state.current,
      to: version,
      state: 'running',
      step: 'backup',
      startedAt: '2030-01-01T12:01:00.000Z',
      finishedAt: null,
      problem: null,
    };
    return this.answer(`apply ${version}`);
  }
}

interface View {
  configured: boolean;
  reachable: boolean;
  current: string;
  available: { version: string; notes: string } | null;
  job: { id: string; state: string } | null;
  refused: string | null;
  error?: { code: string };
}

let env: TestEnv;
let bare: TestEnv;
let s: Scenario;
let fake: FakeUpdater;

const confirmCode = (person: Person): Promise<unknown> =>
  env.admin.query(`UPDATE auth.sessions SET step_up_at = now() WHERE user_id = $1`, [person.id]);
const audited = async (action: string): Promise<number> =>
  Number(
    (
      await env.admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.log WHERE action = $1`,
        [action],
      )
    ).rows[0]?.n ?? 0,
  );

beforeAll(async () => {
  fake = new FakeUpdater();
  env = await createTestEnv({ updater: fake });
  s = await buildScenario(env);
  bare = await createTestEnv();
});
afterAll(async () => {
  await env.close();
  await bare.close();
});

describe('updates in the app', () => {
  it('are for owners only', async () => {
    for (const person of [s.marta, s.nuno, s.ana]) {
      expect((await person.browser.get('/api/updates')).status, person.id).toBe(403);
      expect((await person.browser.post('/api/updates/check')).status, person.id).toBe(403);
      expect(
        (await person.browser.post('/api/updates/apply', { version: '1.5.0' })).status,
        person.id,
      ).toBe(403);
    }
    expect(fake.asked).toEqual([]);
  });

  it('look for a newer version and keep that on the record', async () => {
    const found = await s.owner.browser.post<View>('/api/updates/check');
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({
      configured: true,
      reachable: true,
      current: '1.4.0',
      available: { version: '1.5.0' },
    });
    expect(await audited('update.checked')).toBe(1);
  });

  it('apply only with the code confirmed again, on the record, the outcome recorded once', async () => {
    await expireStepUp(env, s.owner);
    const asked = await s.owner.browser.post<View>('/api/updates/apply', { version: '1.5.0' });
    expect(asked.status).toBe(403);
    expect(asked.body.error?.code).toBe('step_up_required');
    expect(fake.asked.some((what) => what.startsWith('apply'))).toBe(false);

    await confirmCode(s.owner);
    expect((await s.owner.browser.post('/api/updates/apply', { version: 'latest' })).status).toBe(
      400,
    );
    const started = await s.owner.browser.post<View>('/api/updates/apply', { version: '1.5.0' });
    expect(started.status).toBe(200);
    expect(started.body.job).toMatchObject({ state: 'running' });
    expect(await audited('update.requested')).toBe(1);

    if (fake.state.job !== null) {
      fake.state.job = { ...fake.state.job, state: 'applied', step: 'health', finishedAt: 'x' };
    }
    fake.state.current = '1.5.0';
    await s.owner.browser.get('/api/updates');
    await s.owner.browser.get('/api/updates');
    expect(await audited('update.applied')).toBe(1);
  });

  it('show a refusal from the updater and keep it on the record', async () => {
    fake.refuse = 'signature_invalid';
    const refused = await s.owner.browser.post<View>('/api/updates/apply', { version: '1.6.0' });
    expect(refused.status).toBe(200);
    expect(refused.body.refused).toBe('signature_invalid');
    expect(await audited('update.refused')).toBe(1);
    fake.refuse = null;
  });

  it('say when the updater cannot be reached, and when there is none', async () => {
    fake.reachable = false;
    const away = await s.owner.browser.get<View>('/api/updates');
    expect(away.body).toMatchObject({ configured: true, reachable: false, current: '1.4.0' });
    expect((await s.owner.browser.post<View>('/api/updates/check')).body.error?.code).toBe(
      'updater_unreachable',
    );
    fake.reachable = true;

    const alone = await buildScenario(bare);
    const none = await alone.owner.browser.get<View>('/api/updates');
    expect(none.body).toMatchObject({ configured: false, current: '1.4.0', available: null });
    const check = await alone.owner.browser.post<View>('/api/updates/check');
    expect(check.status).toBe(503);
    expect(check.body.error?.code).toBe('updater_missing');
  });
});

describe('talking to the updater', () => {
  const key = Buffer.alloc(32, 7);
  const request = {
    method: 'POST',
    path: '/apply',
    body: '{"version":"1.5.0"}',
    time: 1_900_000_000_000,
    nonce: 'abcdefghijklmnop',
  };

  it('signs every request so it cannot be forged, changed or replayed later', () => {
    const headers = sign(key, request);
    const now = request.time + 1_000;
    expect(verify(key, { ...request, headers }, now)).toBe(true);
    expect(verify(key, { ...request, body: '{"version":"9.9.9"}', headers }, now)).toBe(false);
    expect(verify(key, { ...request, path: '/check', headers }, now)).toBe(false);
    expect(verify(key, { ...request, method: 'GET', headers }, now)).toBe(false);
    expect(verify(Buffer.alloc(32, 8), { ...request, headers }, now)).toBe(false);
    expect(verify(key, { ...request, headers }, request.time + 61_000)).toBe(false);
    expect(
      verify(key, { ...request, headers: { ...headers, 'x-cerebro-nonce': 'curto' } }, now),
    ).toBe(false);
    expect(verify(key, { ...request, headers: {} }, now)).toBe(false);
  });

  it('sends signed requests, and tells a refusal from silence', async () => {
    const seen: boolean[] = [];
    const server: Server = createServer((incoming, reply) => {
      let body = '';
      incoming.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      incoming.on('end', () => {
        const ok = verify(
          key,
          {
            method: incoming.method ?? '',
            path: incoming.url ?? '',
            body,
            headers: incoming.headers as Record<string, string>,
          },
          Date.now(),
        );
        seen.push(ok);
        if (incoming.url === '/apply') {
          reply.writeHead(409, { 'content-type': 'application/json' });
          reply.end(JSON.stringify({ error: { code: 'busy' } }));
          return;
        }
        reply.writeHead(200, { 'content-type': 'application/json' });
        reply.end(
          JSON.stringify({ current: '1.4.0', checkedAt: null, available: null, job: null }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const updater = httpUpdater(`http://127.0.0.1:${String(port)}`, key);
    expect((await updater.status()).current).toBe('1.4.0');
    await expect(updater.apply('1.5.0')).rejects.toMatchObject({ code: 'busy' });
    expect(seen).toEqual([true, true]);
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    await expect(updater.check()).rejects.toBeInstanceOf(UpdaterUnreachable);
  });
});
