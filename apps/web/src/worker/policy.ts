/*
 * What the service worker does with each request. It keeps only the page, its
 * fingerprinted files and the installation's brand (public: the sign-in page
 * shows it), so the app opens without a connection; it never touches the API,
 * so no answer with data is ever stored by it.
 */

export type Handling =
  /** Not for the worker: the browser fetches it as if there were none. */
  | 'pass'
  /** A fingerprinted file: it never changes, so the kept copy is answered first. */
  | 'asset'
  /** Opening a screen: the network first, the kept page only when it cannot be reached. */
  | 'page'
  /** The brand's color and icons: the network first, the last copy when it cannot be reached. */
  | 'brand';

export const CACHE_PREFIX = 'cerebro-shell-';

/** Kept apart from the page's versions: a new version of the page keeps the brand. */
export const BRAND_CACHE = 'cerebro-brand';

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
  if (
    url.pathname === '/brand.css' ||
    /^\/brand\/[a-z0-9-]+\.png$/.test(url.pathname) ||
    /^\/icons\/[a-z0-9-]+\.png$/.test(url.pathname)
  )
    return 'brand';
  return 'pass';
}

/** The caches an older version left behind. */
export function stale(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== current);
}
