import type { AddressInfo } from 'node:net';
import { sign, UpdaterRefusal, type UpdaterStatus } from '@cerebro/shared/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Engine } from '../src/engine.js';
import { updaterServer } from '../src/server.js';

/*
 * The updater answers only signed requests from the API: within a minute,
 * never the same one twice, and with nothing to say to anyone else.
 */

const KEY = Buffer.alloc(32, 3);
const asked: string[] = [];
const engine = {
  status: () => {
    asked.push('status');
    return Promise.resolve({ current: '1.4.0', checkedAt: null, available: null, job: null });
  },
  check: () => Promise.reject(new UpdaterRefusal('signature_invalid')),
  apply: (version: string) => {
    asked.push(`apply ${version}`);
    return Promise.resolve({ current: '1.4.0', checkedAt: null, available: null, job: null });
  },
} as unknown as Engine;

const server = updaterServer(engine, KEY);
let base = '';
beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

let counter = 0;
const send = (
  method: 'GET' | 'POST',
  path: string,
  body = '',
  change: { key?: Buffer; time?: number; nonce?: string; path?: string } = {},
) => {
  counter += 1;
  const headers = sign(change.key ?? KEY, {
    method,
    path,
    body,
    time: change.time ?? Date.now(),
    nonce: change.nonce ?? `pedido-numero-${String(counter).padStart(6, '0')}`,
  });
  return fetch(`${base}${change.path ?? path}`, {
    method,
    headers: { ...headers },
    ...(body === '' ? {} : { body }),
  });
};

describe('the updater door', () => {
  it('answers signed requests', async () => {
    const response = await send('GET', '/status');
    expect(response.status).toBe(200);
    expect(((await response.json()) as UpdaterStatus).current).toBe('1.4.0');
    expect((await send('POST', '/apply', '{"version":"1.5.0"}')).status).toBe(200);
    expect(asked).toEqual(['status', 'apply 1.5.0']);
  });

  it('turns away the unsigned, the wrongly signed, the stale and the replayed, saying nothing', async () => {
    asked.length = 0;
    expect((await fetch(`${base}/status`)).status).toBe(401);
    expect((await send('GET', '/status', '', { key: Buffer.alloc(32, 4) })).status).toBe(401);
    expect((await send('GET', '/status', '', { time: Date.now() - 120_000 })).status).toBe(401);
    expect((await send('POST', '/apply', '{"version":"1.5.0"}', { path: '/check' })).status).toBe(
      401,
    );
    expect((await send('GET', '/status', '', { nonce: 'sempre-o-mesmo-numero' })).status).toBe(200);
    const again = await send('GET', '/status', '', { nonce: 'sempre-o-mesmo-numero' });
    expect(again.status).toBe(401);
    expect(await again.json()).toEqual({ error: { code: 'unsigned' } });
    expect(asked).toEqual(['status']);
  });

  it('passes refusals on by their code, and knows only its three addresses', async () => {
    const refused = await send('POST', '/check');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: 'signature_invalid' } });
    expect((await send('POST', '/apply', '{}')).status).toBe(400);
    expect((await send('GET', '/qualquer')).status).toBe(404);
    expect((await send('POST', '/apply', 'x'.repeat(5000))).status).toBe(401);
  });
});
