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

// No skipWaiting, deliberately. A new worker activates by deleting every cache
// but its own, and the page running right now is an older shell still asking
// for older hashed assets. Taking over mid-session would pull those out from
// under it, and the server answers a vanished /assets/ URL with a 404. Waiting
// costs one launch of staleness and removes that whole class of failure.
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)));
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

  // Navigations: answer from cache instantly, renew in the background.
  //
  // The shell is ~600 bytes of HTML whose only job is to point at hashed
  // assets, and this worker's cache holds a matching set of them. Fetching it
  // first put a full round trip in front of every launch: unnoticeable on the
  // LAN, 200-400 ms over Tailscale, on an app that is open for ten seconds at a
  // time. The refresh below still lands, so a deploy is picked up on the next
  // launch (see the install handler for why it is the next one and not this).
  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('/index.html').then((cached) => {
        const network = fetch(request).then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('/index.html', copy)));
          }
          return res;
        });

        if (cached) {
          // Already answered; the refresh must never surface its own failure.
          event.waitUntil(network.catch(() => {}));
          return cached;
        }

        // Nothing cached (first launch, or the cache was evicted): the network
        // is the only answer. The deadline stops an unreachable bridge from
        // parking iOS on a white screen for tens of seconds.
        return Promise.race([
          network,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error('navigation timeout')), NAV_TIMEOUT_MS);
          }),
        ]);
      }),
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
