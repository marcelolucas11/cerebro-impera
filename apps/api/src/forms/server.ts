import rateLimit from '@fastify/rate-limit';
import type { PublicForm } from '@cerebro/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { addressGroup, trustHops } from '../http/proxy.js';
import { brandStyleSheet } from '../modules/brand.js';
import { readAnswer, type FormBody } from './answer.js';
import { closedPage, formPage, FORM_STYLE, fullPage, sentPage } from './page.js';
import { checkStamp, issueStamp } from './stamp.js';

/*
 * The forms service: an address of its own that only shows and sends forms.
 *
 * - Its database role can call three functions and read no table.
 * - It has no session, no cookie and no key of the app, and serves nothing of the app.
 * - Its pages carry no script; each answer is read field by field here and again
 *   in the database.
 * - It answers only under its own host name, takes only plain form posts from
 *   its own pages, and limits how often each address may send.
 */

export interface FormsDeps {
  pool: Pick<pg.Pool, 'query'>;
  /** Signs the stamp each page carries. */
  key: Buffer;
  /** Exact origin the forms are served from, e.g. https://formularios.exemplo.com */
  origin: string;
  /** How many proxies in front set X-Forwarded-For (see Config.trustProxy). */
  trustProxy: number;
  now: () => number;
  logger: boolean;
  /** Sends allowed per address within ten minutes. */
  sendsPerWindow?: number;
}

const SLUG = /^[A-Za-z0-9_-]{22}$/;

/** Nothing on these pages may run, load from elsewhere, be framed or post elsewhere. */
export const FORMS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "style-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

const HEADERS = {
  'content-security-policy': FORMS_CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Not "no-referrer": with it, browsers send a form's own post with "Origin: null", and the
  // check below could not tell it from a post made elsewhere. The page links nowhere else.
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
  'strict-transport-security': 'max-age=31536000',
};

interface Brand {
  name: string;
  color: string | null;
}

export async function buildFormsApp(deps: FormsDeps): Promise<FastifyInstance> {
  const host = new URL(deps.origin).host;
  const app = Fastify({
    logger: deps.logger ? { redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    trustProxy: trustHops(deps.trustProxy),
    bodyLimit: 64 * 1024,
  });

  // Only plain form posts, read without any library: each name once, nothing nested.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      const fields: FormBody = Object.create(null) as FormBody;
      for (const [name, value] of new URLSearchParams(body as string)) {
        if (name in fields || Object.keys(fields).length >= 60) {
          done(Object.assign(new Error('bad form'), { statusCode: 400 }), undefined);
          return;
        }
        fields[name] = value;
      }
      done(null, fields);
    },
  );

  // Counted by address; an IPv6 network counts as one (whoever has one has its 2^64 addresses).
  const byAddress = (request: FastifyRequest): string => addressGroup(request.ip);
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: 60_000,
    keyGenerator: byAddress,
    errorResponseBuilder: () => ({ statusCode: 429, error: 'too_many_requests' }),
  });

  app.addHook('onRequest', (request, reply, done) => {
    // Under any other name (a proxy sending the app's traffic here, say), nothing. The
    // health check, which says nothing, answers to the container's own check too.
    if (request.host !== host && request.url !== '/health') {
      void reply.status(404).type('text/plain; charset=utf-8').send('Não encontrado.');
      return;
    }
    if (request.method === 'POST') {
      const site = request.headers['sec-fetch-site'];
      if (
        request.headers.origin !== deps.origin ||
        (site !== undefined && site !== 'same-origin')
      ) {
        void reply.status(403).type('text/plain; charset=utf-8').send('Envie pela própria página.');
        return;
      }
    }
    done();
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(HEADERS)) {
      if (!reply.hasHeader(name)) void reply.header(name, value);
    }
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store');
    done(null, payload);
  });
  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).type('text/plain; charset=utf-8').send('Pedido não aceito.');
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).type('text/plain; charset=utf-8').send('Algo falhou. Tente de novo.');
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).type('text/plain; charset=utf-8').send('Não encontrado.'),
  );

  const brand = async (): Promise<Brand> => {
    const result = await deps.pool.query<{ brand: Brand }>('SELECT app.forms_brand() AS brand');
    return result.rows[0]?.brand ?? { name: '', color: null };
  };
  const view = async (slug: string): Promise<PublicForm | null> => {
    const result = await deps.pool.query<{ form: PublicForm | null }>(
      'SELECT app.form_view($1) AS form',
      [slug],
    );
    return result.rows[0]?.form ?? null;
  };
  const html = (reply: FastifyReply, status: number, page: string): FastifyReply =>
    reply.status(status).type('text/html; charset=utf-8').send(page);
  const slugOf = (request: FastifyRequest): string | null => {
    const slug = (request.params as { slug?: unknown }).slug;
    return typeof slug === 'string' && SLUG.test(slug) ? slug : null;
  };

  app.get('/health', async () => {
    await deps.pool.query('SELECT 1');
    return { status: 'ok' };
  });
  app.get('/form.css', (_request, reply) =>
    reply.header('cache-control', 'no-cache').type('text/css; charset=utf-8').send(FORM_STYLE),
  );
  app.get('/brand.css', async (_request, reply) => {
    const { color } = await brand();
    return reply
      .header('cache-control', 'no-cache')
      .type('text/css; charset=utf-8')
      .send(brandStyleSheet(color));
  });

  app.get('/f/:slug', async (request, reply) => {
    const slug = slugOf(request);
    const { name } = await brand();
    const form = slug === null ? null : await view(slug);
    if (slug === null || form === null) return html(reply, 404, closedPage(name));
    return html(
      reply,
      200,
      formPage({ slug, brand: name, form, stamp: issueStamp(deps.key, slug, deps.now()) }),
    );
  });

  app.get('/f/:slug/enviado', async (request, reply) => {
    const slug = slugOf(request);
    const { name } = await brand();
    const form = slug === null ? null : await view(slug);
    return html(reply, 200, sentPage(name, form?.title ?? null));
  });

  app.post(
    '/f/:slug',
    {
      config: {
        rateLimit: {
          max: deps.sendsPerWindow ?? 10,
          timeWindow: 10 * 60_000,
          keyGenerator: byAddress,
        },
      },
    },
    async (request, reply) => {
      const slug = slugOf(request);
      const { name } = await brand();
      const form = slug === null ? null : await view(slug);
      if (slug === null || form === null) return html(reply, 404, closedPage(name));
      const body = (request.body ?? {}) as FormBody;
      const now = deps.now();
      const again = (status: number, extra: { errors?: Record<string, string>; notice?: string }) =>
        html(
          reply,
          status,
          formPage({
            slug,
            brand: name,
            form,
            stamp: issueStamp(deps.key, slug, now),
            values: body,
            ...extra,
          }),
        );

      // A robot that fills in the hidden question is thanked, and nothing is kept.
      if ((body._site ?? '') !== '') return reply.redirect(`/f/${slug}/enviado`, 303);
      const stamp = checkStamp(deps.key, slug, body._stamp ?? '', now);
      if (stamp === 'too_fast')
        return again(400, { notice: 'Envio rápido demais. Confira as respostas e envie de novo.' });
      if (stamp === 'expired')
        return again(400, {
          notice: 'A página ficou aberta muito tempo. Confira e envie de novo.',
        });
      if (stamp === 'invalid')
        return again(400, { notice: 'Envie pela própria página do formulário.' });

      const read = readAnswer(form, body);
      if (!read.ok) return again(400, { errors: read.errors });

      const sent = await deps.pool.query<{ outcome: string }>(
        'SELECT app.form_submit($1, $2, $3, $4::jsonb) AS outcome',
        [slug, read.answer.title, read.answer.description, JSON.stringify(read.answer.values)],
      );
      const outcome = sent.rows[0]?.outcome;
      if (outcome === 'sent') return reply.redirect(`/f/${slug}/enviado`, 303);
      if (outcome === 'full') return html(reply, 503, fullPage(name));
      return html(reply, 404, closedPage(name));
    },
  );

  return app;
}
