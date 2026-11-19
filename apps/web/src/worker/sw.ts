import { BRAND_CACHE, CACHE_PREFIX, handling, stale } from './policy.js';

/*
 * The service worker: built on its own into /sw.js (see vite.config.ts), with
 * the list of the page's files written in at build time. It keeps the page so
 * the app can be installed and opened offline; it stores no data.
 */

declare const __SHELL_FILES__: string[];
declare const __SHELL_VERSION__: string;

interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  readonly location: { origin: string };
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const worker = self as unknown as WorkerScope;
const CACHE = `${CACHE_PREFIX}${__SHELL_VERSION__}`;
const PAGE = '/index.html';

worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([PAGE, ...__SHELL_FILES__]))
      .then(() => worker.skipWaiting()),
  );
});

worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(stale(names, CACHE).map((name) => caches.delete(name))))
      .then(() => worker.clients.claim()),
  );
});

worker.addEventListener('fetch', (event) => {
  const how = handling(event.request, worker.location.origin);
  if (how === 'asset') {
    event.respondWith(
      caches
        .match(event.request, { cacheName: CACHE })
        .then((kept) => kept ?? fetch(event.request)),
    );
  } else if (how === 'brand') {
    // Asked for without its version, so one address keeps one copy.
    const key = new URL(event.request.url);
    key.search = '';
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(BRAND_CACHE).then((cache) => cache.put(key.href, copy));
          }
          return response;
        })
        .catch(() =>
          caches
            .match(key.href, { cacheName: BRAND_CACHE })
            .then((kept) => kept ?? Response.error()),
        ),
    );
  } else if (how === 'page') {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(PAGE, { cacheName: CACHE }).then((kept) => kept ?? Response.error()),
      ),
    );
  }
});
