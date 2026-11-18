/*
 * What the service worker does with each request. It keeps only the page and
 * its fingerprinted files, so the app opens without a connection; it never
 * touches the API, so no answer with data is ever stored by it.
 */

export type Handling =
  /** Not for the worker: the browser fetches it as if there were none. */
  | 'pass'
  /** A fingerprinted file: it never changes, so the kept copy is answered first. */
  | 'asset'
  /** Opening a screen: the network first, the kept page only when it cannot be reached. */
  | 'page';

export const CACHE_PREFIX = 'cerebro-shell-';

export function handling(
  request: { method: string; mode: string; url: string },
  origin: string,
): Handling {
  if (request.method !== 'GET') return 'pass';
  const url = new URL(request.url);
  if (url.origin !== origin) return 'pass';
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return 'pass';
  if (request.mode === 'navigate') return 'page';
  if (url.pathname.startsWith('/assets/')) return 'asset';
  return 'pass';
}

/** The caches an older version left behind. */
export function stale(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}
