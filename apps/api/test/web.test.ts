import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadBundle } from '../src/http/web.js';
import { createTestEnv, ORIGIN, type TestEnv } from './support/env.js';

/*
 * The API also hands out the web app. These tests are about what that must
 * never do: run code that is not ours, answer from outside its folder, or
 * weaken the rules that protect the API.
 */

const MARKER = 'conteudo-que-nunca-pode-sair';
const PAGE = '<!doctype html><title>app</title><div id="app"></div>';

let scratch: string;
let env: TestEnv;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'cerebro-web-'));
  const root = join(scratch, 'web');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), PAGE);
  writeFileSync(join(root, 'assets', 'app-4f9a1c.js'), 'console.log("app")');
  writeFileSync(join(root, 'assets', 'face-77ab02.woff2'), Buffer.from([1, 2, 3]));
  // Things that sit next to, or inside, the folder and must stay unreachable.
  writeFileSync(join(scratch, 'secrets.json'), MARKER);
  writeFileSync(join(root, '.env'), MARKER);
  writeFileSync(join(root, 'notas.md'), MARKER);
  symlinkSync(join(scratch, 'secrets.json'), join(root, 'atalho.json'));
  env = await createTestEnv({ webRoot: root });
});
afterAll(async () => {
  await env.close();
  rmSync(scratch, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  env.app.inject({ method: 'GET', url, headers });

describe('the page', () => {
  it('comes with a policy that forbids inline code and anything from other origins', async () => {
    const response = await get('/');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toBe(PAGE);

    const policy = String(response.headers['content-security-policy']);
    const directives = new Map(
      policy.split('; ').map((directive) => {
        const [name, ...values] = directive.split(' ');
        return [name, values.join(' ')];
      }),
    );
    expect(directives.get('default-src')).toBe("'none'");
    for (const name of ['script-src', 'style-src', 'font-src', 'img-src', 'connect-src']) {
      expect(directives.get(name), name).toBe("'self'");
    }
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('form-action')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(policy).not.toMatch(/unsafe|data:|blob:|https?:|\*/);

    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
    expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(String(response.headers['permissions-policy'])).toContain('camera=()');
  });

  it('is the answer for every screen address', async () => {
    for (const url of ['/convite', '/espacos/123/listas/456', '/convite?x=1']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).toBe(PAGE);
    }
  });

  it('is always revalidated, while fingerprinted files are cached for good', async () => {
    const page = await get('/');
    expect(page.headers['cache-control']).toBe('no-cache');
    const unchanged = await get('/', { 'if-none-match': String(page.headers.etag) });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.body).toBe('');

    const script = await get('/assets/app-4f9a1c.js');
    expect(script.statusCode).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/assets/face-77ab02.woff2')).headers['content-type']).toBe('font/woff2');

    // A missing file is not cached as if it were permanent, and is not the page.
    const missing = await get('/assets/app-000000.js');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
  });

  it('can be opened from a link anywhere, since it holds no data', async () => {
    for (const site of ['cross-site', 'same-site', 'none', 'same-origin']) {
      const response = await get('/convite', { 'sec-fetch-site': site });
      expect(response.statusCode, site).toBe(200);
    }
  });
});

describe('what the page server never does', () => {
  it('never answers with a file from outside its folder, a hidden file or an unknown kind', async () => {
    const attempts = [
      '/../secrets.json',
      '/%2e%2e/secrets.json',
      '/..%2fsecrets.json',
      '/..%5csecrets.json',
      '/assets/../../secrets.json',
      '/assets/..%2f..%2fsecrets.json',
      '/assets/%2e%2e/%2e%2e/secrets.json',
      '//secrets.json',
      '/.env',
      '/%2eenv',
      '/notas.md',
      '/atalho.json',
      '/index.html%00.md',
      '/secrets.json',
    ];
    for (const url of attempts) {
      const response = await get(url);
      expect(response.body, url).not.toContain(MARKER);
      expect([200, 400, 404], url).toContain(response.statusCode);
      if (response.statusCode === 200) expect(response.body, url).toBe(PAGE);
    }
    expect((await get('/.env')).statusCode).toBe(404);
    expect((await get('/atalho.json')).statusCode).toBe(404);
    expect((await get('/notas.md')).statusCode).toBe(404);
  });

  it('never answers an API address with the page', async () => {
    for (const url of ['/api', '/api/', '/api/nao-existe', '/api/users/x/y/z']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json(), url).toEqual({ error: { code: 'not_found' } });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
    }
    const posted = await env.app.inject({
      method: 'POST',
      url: '/',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(posted.statusCode).toBe(404);
    expect(posted.body).not.toContain('<div');
  });

  it('never loosens the API: requests from other sites are still refused there', async () => {
    for (const site of ['cross-site', 'same-site']) {
      for (const url of ['/api/health', '/api/me', '/api/setup/status']) {
        const response = await get(url, { 'sec-fetch-site': site });
        expect(response.statusCode, `${site} ${url}`).toBe(403);
      }
    }
    const forged = await env.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'https://outro.exemplo.test', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(forged.statusCode).toBe(403);
    expect((await get('/api/health')).statusCode).toBe(200);
  });
});

describe('starting up', () => {
  it('fails loudly when the folder has no page, instead of serving nothing', () => {
    const empty = mkdtempSync(join(scratch, 'vazio-'));
    expect(() => loadBundle(empty)).toThrow();
    expect(() => loadBundle(join(scratch, 'nao-existe'))).toThrow();
  });

  it('can run as an API alone, answering no page at all', async () => {
    const apiOnly = await buildApp({ ...env.deps, config: { ...env.deps.config, webRoot: null } });
    try {
      const response = await apiOnly.inject({ method: 'GET', url: '/' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'not_found' } });
      const crossSite = await apiOnly.inject({
        method: 'GET',
        url: '/qualquer',
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSite.statusCode).toBe(403);
    } finally {
      await apiOnly.close();
    }
  });
});
