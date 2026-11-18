import { createServer, type IncomingMessage, type Server } from 'node:http';
import { SIGNATURE_WINDOW_MS, UpdaterRefusal, verify } from '@cerebro/shared/protocol';
import type { Engine } from './engine.js';

/*
 * The updater's door: three addresses, answered only to requests signed with
 * the key the API has, within a minute, never twice. Anything else gets the
 * same short refusal, with nothing about why.
 */

const BODY_LIMIT = 4096;

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

export function updaterServer(engine: Engine, key: Buffer, now: () => number = Date.now): Server {
  // One-time numbers seen within the window; older ones can no longer be replayed anyway.
  const seen = new Map<string, number>();
  const forgetOld = (at: number): void => {
    for (const [nonce, when] of seen) if (at - when > 2 * SIGNATURE_WINDOW_MS) seen.delete(nonce);
  };

  return createServer((request, reply) => {
    const answer = (status: number, value: unknown): void => {
      reply.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      reply.end(JSON.stringify(value));
    };
    void (async () => {
      const body = await readBody(request);
      const at = now();
      const header = (name: string): string | undefined => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : undefined;
      };
      const nonce = header('x-cerebro-nonce');
      const signed =
        body !== null &&
        nonce !== undefined &&
        !seen.has(nonce) &&
        verify(
          key,
          {
            method: request.method ?? '',
            path: request.url ?? '',
            body,
            headers: {
              'x-cerebro-time': header('x-cerebro-time'),
              'x-cerebro-nonce': nonce,
              'x-cerebro-signature': header('x-cerebro-signature'),
            },
          },
          at,
        );
      if (!signed) {
        answer(401, { error: { code: 'unsigned' } });
        return;
      }
      forgetOld(at);
      seen.set(nonce, at);
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
