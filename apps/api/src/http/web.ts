import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

/*
 * The web bundle is served by the API itself, from memory.
 *
 * Every file is read once at startup into a fixed table of exact addresses.
 * A request can only pick an entry from that table: no path from the network
 * is ever resolved against the filesystem, so there is nothing to traverse.
 */

/** Only these kinds of file are ever served; anything else in the folder is ignored. */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/*
 * What the page is allowed to do. Scripts, styles and fonts only from this
 * origin, no inline code, requests only to this origin, never framed, and
 * forms never submitted by the browser itself (so a password can never end up
 * in an address bar if the script fails to load).
 */
export const APP_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  // Audio and video attachments play from this origin only.
  "media-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // Nothing turns text into script: the page writes no HTML from strings, and the one
  // script address it hands the browser (the offline worker) passes through the only
  // policy allowed, which accepts that address alone.
  "require-trusted-types-for 'script'",
  'trusted-types cerebro',
].join('; ');

const DOCUMENT_HEADERS = {
  // Always revalidated, so a security fix reaches every browser on its next visit.
  'cache-control': 'no-cache',
  'content-security-policy': APP_CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy':
    'camera=(), geolocation=(), microphone=(), payment=(), usb=(), browsing-topics=()',
};

/** Files under /assets/ carry a hash of their content in the name: they never change. */
const ASSET_CACHE = 'public, max-age=31536000, immutable';

interface BundleFile {
  body: Buffer;
  type: string;
  etag: string;
}

export type Bundle = ReadonlyMap<string, BundleFile>;

export function loadBundle(root: string): Bundle {
  const files = new Map<string, BundleFile>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      // Regular files only: links and anything unusual are left out.
      if (!entry.isFile()) continue;
      const type = CONTENT_TYPES[extname(entry.name).toLowerCase()];
      if (type === undefined) continue;
      const body = readFileSync(full);
      const digest = createHash('sha256').update(body).digest('base64url');
      files.set(`/${relative(root, full).split(sep).join('/')}`, {
        body,
        type,
        etag: `"${digest.slice(0, 27)}"`,
      });
    }
  };
  walk(root);
  if (!files.has('/index.html')) throw new Error(`the web bundle has no index.html: ${root}`);
  return files;
}

/** The address without its query string, exactly as received: nothing is decoded. */
export function pathOf(url: string): string {
  const end = url.indexOf('?');
  return end === -1 ? url : url.slice(0, end);
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/**
 * Answers a request no API route matched. Returns false when it is not for the
 * web bundle, so the caller can reply "not found".
 */
export function serveFromBundle(
  bundle: Bundle,
  request: FastifyRequest,
  reply: FastifyReply,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = pathOf(request.url);
  if (isApiPath(path)) return false;

  let file = bundle.get(path);
  if (!file) {
    // An address with a dot in its last part names a file that does not exist.
    // Anything else is a screen of the app, which the page itself resolves.
    const lastPart = path.slice(path.lastIndexOf('/') + 1);
    if (lastPart.includes('.')) return false;
    file = bundle.get('/index.html');
    if (!file) return false;
  }

  void reply.header('etag', file.etag);
  if (path.startsWith('/assets/')) {
    void reply.header('cache-control', ASSET_CACHE);
  } else {
    void reply.headers(DOCUMENT_HEADERS);
  }
  if (request.headers['if-none-match'] === file.etag) {
    void reply.status(304).send();
    return true;
  }
  void reply.type(file.type).send(file.body);
  return true;
}
