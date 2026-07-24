// Minimal service worker: cache the static app shell for offline install ONLY.
// Live AC state is NEVER cached — it always hits the network so we never show a
// stale reading.

// Both placeholders are stamped by scripts/inject-sw.mjs after `vite build`:
// the app version keys the cache, so every deploy activates a fresh cache and
// deletes the old one instead of accreting dead hashed assets forever; the
// built bundle files join the precache so an install works offline even when
// the first visit fetched them before this worker controlled the page.
const CACHE = 'ac-shell-__APP_VERSION__';
const ASSETS = /* __PRECACHE_ASSETS__ */ [];
// Cache matching is query-sensitive, so these must be the EXACT URLs the app
// requests (index.html, manifest, and useTheme all use ?v=4 for the SVGs).
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg?v=4', '/icon-dark.svg?v=4', ...ASSETS];

// How long a navigation may wait on the network before the cached shell takes
// over. On the LAN, "bridge down" is an unreachable host: without a deadline
// iOS sits on a white screen for tens of seconds before the fetch gives up.
const NAV_TIMEOUT_MS = 2500;

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

  // Navigations: network-first with a short deadline, fall back to the cached
  // shell. A fresh response also renews the cached shell, so the next offline
  // launch boots the last-deployed app rather than whatever install captured.
  if (request.mode === 'navigate') {
    event.respondWith(
      Promise.race([
        fetch(request),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('navigation timeout')), NAV_TIMEOUT_MS);
        }),
      ])
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('/index.html', copy)));
          }
          return res;
        })
        .catch(() => caches.match('/index.html').then((cached) => cached || fetch(request))),
    );
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
