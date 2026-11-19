import { createServer, type IncomingMessage, type Server } from 'node:http';
import { SIGNATURE_WINDOW_MS, UpdaterRefusal, verify } from '@cerebro/shared/protocol';
import type { Engine } from './engine.js';

/*
 * The updater's door: three addresses, answered only to requests signed with
 * the key the API has, within a minute, never twice, and never from before it
 * started (the numbers already used are kept only in memory, so a request
 * caught before a restart cannot be sent again after it). Anything else gets
 * the same short refusal, with nothing about why.
 */

const BODY_LIMIT = 4096;

/** The body, or null when it is larger than any request the API sends. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    // Past the limit the rest is read and dropped, so the answer still reaches the caller.
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) chunks.push(chunk);
    });
    request.on('end', () => {
      resolve(size > BODY_LIMIT ? null : Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', () => {
      resolve(null);
    });
  });
}

/**
 * The one-time number of a request that is signed with the key, fresh and not seen before
 * (and from then on seen); null for anything else. The signature is checked first: only
 * then is anything the request says taken into account.
 */
function admitted(
  key: Buffer,
  request: IncomingMessage,
  body: string,
  seen: Map<string, number>,
  at: number,
  bootedAt: number,
): string | null {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return typeof value === 'string' ? value : undefined;
  };
  const headers = {
    'x-cerebro-time': header('x-cerebro-time'),
    'x-cerebro-nonce': header('x-cerebro-nonce'),
    'x-cerebro-signature': header('x-cerebro-signature'),
  };
  if (!verify(key, { method: request.method ?? '', path: request.url ?? '', body, headers }, at)) {
    return null;
  }
  if (Number(headers['x-cerebro-time']) < bootedAt) return null;
  const nonce = headers['x-cerebro-nonce'] ?? '';
  for (const [old, when] of seen) if (at - when > 2 * SIGNATURE_WINDOW_MS) seen.delete(old);
  if (seen.has(nonce)) return null;
  seen.set(nonce, at);
  return nonce;
}

export function updaterServer(engine: Engine, key: Buffer, now: () => number = Date.now): Server {
  // One-time numbers already used, while they could still be replayed.
  const seen = new Map<string, number>();
  const bootedAt = now();

  return createServer((request, reply) => {
    const answer = (status: number, value: unknown): void => {
      reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      reply.end(JSON.stringify(value));
    };
    void (async () => {
      const body = await readBody(request);
      if (body === null) {
        answer(413, { error: { code: 'too_large' } });
        return;
      }
      const nonce = admitted(key, request, body, seen, now(), bootedAt);
      if (nonce === null) {
        answer(401, { error: { code: 'unsigned' } });
        return;
      }
      try {
        if (request.method === 'GET' && request.url === '/status') {
          answer(200, await engine.status());
        } else if (request.method === 'POST' && request.url === '/check') {
          answer(200, await engine.check());
        } else if (request.method === 'POST' && request.url === '/apply') {
          const parsed = JSON.parse(body) as { version?: unknown };
          if (typeof parsed.version !== 'string') {
            answer(400, { error: { code: 'bad_request' } });
            return;
          }
          answer(200, await engine.apply(parsed.version));
        } else {
          answer(404, { error: { code: 'not_found' } });
        }
      } catch (error) {
        if (error instanceof UpdaterRefusal) answer(409, { error: { code: error.code } });
        else answer(500, { error: { code: 'updater_error' } });
      }
    })();
  });
}
