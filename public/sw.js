/* Streamdeck service worker (works under a sub-path such as /Torrent-streaming/).
 * 1. WebTorrent stream proxy: serves <scope>webtorrent/<infoHash>/<file> from the
 *    in-page WebTorrent client (registered first so it can respondWith those URLs).
 * 2. App-shell caching for offline launch / fast PWA start.
 */
importScripts('vendor/webtorrent/sw.min.js'); // resolved relative to this script

const SCOPE = new URL(self.registration.scope).pathname; // e.g. "/Torrent-streaming/"
const SHELL_CACHE = 'streamdeck-shell-v3';
const SHELL = ['', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'].map((p) => SCOPE + p);

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
  if (req.method !== 'GET' || url.origin !== self.location.origin) return; // API Worker etc. — always live
  if (!url.pathname.startsWith(SCOPE)) return;
  if (url.pathname.startsWith(SCOPE + 'webtorrent/')) return; // handled by WebTorrent's listener
  if (req.headers.has('range')) return; // media

  const rel = url.pathname.slice(SCOPE.length);
  // Immutable build assets: cache-first
  if (rel.startsWith('_next/static/') || rel.startsWith('vendor/') || rel.startsWith('icons/')) {
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

  // Navigations: network-first, fall back to the cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(SCOPE, copy));
          return res;
        })
        .catch(() => caches.match(SCOPE).then((r) => r || Response.error())),
    );
  }
});
