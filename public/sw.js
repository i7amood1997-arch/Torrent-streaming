/* Streamdeck service worker.
 * 1. WebTorrent stream proxy: serves /webtorrent/<infoHash>/<file> from the
 *    in-page WebTorrent client (must be first so it can respondWith those URLs).
 * 2. App-shell caching for offline launch / fast PWA start.
 */
importScripts('/vendor/webtorrent/sw.min.js');

const SHELL_CACHE = 'streamdeck-shell-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).catch(() => undefined));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('streamdeck-') && k !== SHELL_CACHE).map((k) => caches.delete(k)))),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(self.registration.scope.replace(self.location.origin, '') + 'webtorrent/')) return; // handled above
  if (url.pathname.startsWith('/api/')) return; // always live
  if (req.headers.has('range')) return; // media

  // Immutable build assets: cache-first
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/vendor/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Navigations: network-first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || Response.error())),
    );
  }
});
