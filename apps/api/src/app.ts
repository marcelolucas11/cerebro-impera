import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Deps } from './deps.js';
import { forbidden, fromDatabaseError, HttpError } from './http/errors.js';
import { registerRoutes } from './routes.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger:
      config.env === 'test'
        ? false
        : {
            // Never write credentials to the logs.
            redact: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers["set-cookie"]',
            ],
          },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  // Only JSON bodies are accepted. Dropping the text parser also means a
  // plain HTML form (which cannot send JSON) can never reach a handler.
  app.removeContentTypeParser('text/plain');
  await app.register(cookie);

  /*
   * Cross-origin gate. Other applications live on sibling subdomains of the
   * same domain, and browsers treat those as the "same site": SameSite cookies
   * alone would not stop a request forged from one of them. So every
   * state-changing request must carry this application's exact Origin, and any
   * request the browser labels as coming from elsewhere is refused.
   */
  app.addHook('onRequest', (request, _reply, done) => {
    const site = request.headers['sec-fetch-site'];
    if (!SAFE_METHODS.has(request.method)) {
      if (request.headers.origin !== config.publicOrigin) {
        done(forbidden('bad_origin'));
        return;
      }
      if (site !== undefined && site !== 'same-origin') {
        done(forbidden('bad_origin'));
        return;
      }
    } else if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      done(forbidden('bad_origin'));
      return;
    }
    done();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    void reply.headers({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      // Scoped to this host on purpose: sibling subdomains belong to other systems.
      'strict-transport-security': 'max-age=31536000',
    });
    done(null, payload);
  });

  app.setErrorHandler((error, request, reply) => {
    const known = error instanceof HttpError ? error : fromDatabaseError(error);
    if (known) {
      const retryAfter = known.details?.retryAfterSeconds;
      if (known.status === 429 && typeof retryAfter === 'number') {
        void reply.header('retry-after', String(retryAfter));
      }
      return reply.status(known.status).send({
        error: { code: known.code, ...(known.details ? { details: known.details } : {}) },
      });
    }

    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: 'bad_request' } });
    }
    // Details stay in the server log; the client learns nothing about internals.
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: { code: 'not_found' } }),
  );

  registerRoutes(app, deps);
  return app;
}
