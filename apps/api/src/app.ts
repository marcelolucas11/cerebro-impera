import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { digest } from './crypto/tokens.js';
import { readToken, SESSION_COOKIE } from './http/cookies.js';
import type { Deps } from './deps.js';
import { forbidden, fromDatabaseError, HttpError, tooManyRequests } from './http/errors.js';
import { isApiPath, loadBundle, pathOf, serveFromBundle } from './http/web.js';
import { registerRoutes } from './routes.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whose requests are counted together: a session, by a digest of its token
 * (never the token itself), or the address before anyone signs in. Counting by
 * session keeps a whole office behind one address from sharing one allowance.
 */
function rateKey(request: FastifyRequest): string {
  const token = readToken(request, SESSION_COOKIE);
  return token === undefined
    ? `ip:${request.ip}`
    : `session:${digest(token).toString('base64url')}`;
}

/** Sent with every response unless the handler already chose something more specific. */
const DEFAULT_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Scoped to this host on purpose: sibling subdomains belong to other systems.
  'strict-transport-security': 'max-age=31536000',
};

export async function buildApp(deps: Deps): Promise<FastifyInstance> {
  const { config } = deps;
  const bundle = config.webRoot === null ? null : loadBundle(config.webRoot);
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

  // Every route is limited; routes may ask for a tighter limit of their own.
  await app.register(rateLimit, {
    global: true,
    max: config.requestsPerMinute,
    timeWindow: 60_000,
    keyGenerator: rateKey,
    errorResponseBuilder: (_request, context) =>
      tooManyRequests(Math.max(1, Math.ceil(context.ttl / 1000))),
  });

  /*
   * Cross-origin gate. Other applications live on sibling subdomains of the
   * same domain, and browsers treat those as the "same site": SameSite cookies
   * alone would not stop a request forged from one of them. So every
   * state-changing request must carry this application's exact Origin, and any
   * request to the API the browser labels as coming from elsewhere is refused.
   *
   * The page itself (static files, no personal data) may be opened from
   * anywhere: an invite link clicked in a webmail or chat must work.
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
    } else if (
      (bundle === null || isApiPath(pathOf(request.url))) &&
      site !== undefined &&
      site !== 'same-origin' &&
      site !== 'none'
    ) {
      done(forbidden('bad_origin'));
      return;
    }
    done();
  });

  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(DEFAULT_HEADERS)) {
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
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

  app.setNotFoundHandler((request, reply) => {
    if (bundle !== null && serveFromBundle(bundle, request, reply)) return reply;
    return reply.status(404).send({ error: { code: 'not_found' } });
  });

  registerRoutes(app, deps);
  return app;
}
