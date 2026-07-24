// Minimal service worker: cache the static app shell for offline install ONLY.
// Live AC state is NEVER cached — it always hits the network so we never show a
// stale reading.

const CACHE = 'umi-ac-shell-v7';
// Cache matching is query-sensitive, so these must be the EXACT URLs the app
// requests (index.html, manifest, and useTheme all use ?v=4 for the SVGs).
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg?v=4', '/icon-dark.svg?v=4'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GETs. Cross-origin and non-GET requests fall
  // through to default network handling — never cached.
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // The bridge serves this app, so the API is SAME-ORIGIN and would otherwise
  // land in the static-asset branch below: live readings would be served from
  // cache, and /api/events — an endless SSE stream — would be cloned into it
  // forever. Always pass the API straight to the network.
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigations: network-first, fall back to the cached shell when offline.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Static assets: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
