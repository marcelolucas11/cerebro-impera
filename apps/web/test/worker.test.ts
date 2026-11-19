import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, handling, stale } from '../src/worker/policy.js';

const ORIGIN = 'https://cerebro.exemplo.test';
const ask = (url: string, mode = 'cors', method = 'GET') =>
  handling({ method, mode, url: `${ORIGIN}${url}` }, ORIGIN);

describe('what the service worker keeps', () => {
  it('never touches the API, whatever the request', () => {
    expect(ask('/api/me')).toBe('pass');
    expect(ask('/api')).toBe('pass');
    expect(ask('/api/lists/1/items', 'navigate')).toBe('pass');
    expect(ask('/api/events')).toBe('pass');
    expect(ask('/api/attachments/1/download', 'navigate')).toBe('pass');
  });

  it('keeps the fingerprinted files and opens screens from the network first', () => {
    expect(ask('/assets/index-abc.js')).toBe('asset');
    expect(ask('/listas/1/quadro', 'navigate')).toBe('page');
    expect(ask('/', 'navigate')).toBe('page');
  });

  it("keeps the installation's brand, network first, and nothing that looks like it", () => {
    expect(ask('/brand.css')).toBe('brand');
    expect(ask('/brand.css?v=%236fb3e0')).toBe('brand');
    expect(ask('/brand/icon-192.png?v=abc')).toBe('brand');
    expect(ask('/icons/maskable-512.png')).toBe('brand');
    expect(ask('/brand/../api/me')).toBe('pass');
    expect(ask('/brand/icon-192.svg')).toBe('pass');
    expect(ask('/brand.css', 'cors', 'PUT')).toBe('pass');
    expect(ask('/api/brand')).toBe('pass');
  });

  it('leaves alone anything else: other methods, other sites, the manifest and itself', () => {
    expect(ask('/assets/index-abc.js', 'cors', 'POST')).toBe('pass');
    expect(handling({ method: 'GET', mode: 'navigate', url: 'https://outro.test/' }, ORIGIN)).toBe(
      'pass',
    );
    expect(ask('/manifest.webmanifest')).toBe('pass');
    expect(ask('/sw.js')).toBe('pass');
    expect(ask('/apix/coisa')).toBe('pass');
  });

  it('drops the caches of older versions, and only its own', () => {
    expect(
      stale([`${CACHE_PREFIX}velho`, `${CACHE_PREFIX}novo`, 'outra-coisa'], `${CACHE_PREFIX}novo`),
    ).toEqual([`${CACHE_PREFIX}velho`]);
  });
});
