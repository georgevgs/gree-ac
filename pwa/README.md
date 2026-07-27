# The PWA

React + Vite + Tailwind client for the bridge in `../gree-hvac-rs`. Installed
via "Add to Home Screen"; state arrives over SSE as it changes, so the UI
reflects the physical remote within milliseconds. Polling stays on as a
fallback: every 15s while the stream is healthy, every 2s when it isn't.

## Develop

```bash
cp .env.example .env         # see below
npm install
npm run dev                  # http://localhost:5173 (also on your LAN IP)
```

Configuration (build-time, in `.env`):

- `VITE_BRIDGE_URL`: the bridge's LAN IP or Tailscale hostname. Leave empty
  when the bridge serves the built PWA (same origin), which is the normal
  setup. Never use `http://localhost` here: on a phone, "localhost" is the
  phone itself.
- `VITE_DEVICE_NAME`: what the app calls the unit (the big name in the header
  and the device card in Settings), e.g. `Umi` or `Living room`. Unset gives
  the generic "AC".

`npm run build` type-checks, bundles, and writes `.br`/`.gz` siblings for
every compressible file (see below). The bridge serves `dist/` when
`PUBLIC_DIR` points at it.

## Offline and caching

The service worker (production only) caches the app shell for offline
install. It never caches live AC state; `/api/*` always goes to the network.

The SW only registers in a secure context. Over a plain `http://192.168.x.x`
LAN URL browsers don't expose the API at all, and the HTTP cache below is what
actually does the work. Reach the app over its HTTPS tailnet name instead (see
[../docs/remote-access.md](../docs/remote-access.md)) and the worker registers,
so the shell boots from cache and the app can render its own offline state
rather than a browser error page.

## Load performance (it matters: the bridge may be a Pi Zero W)

Precompressed `.br`/`.gz` siblings are served straight off disk, so nothing is
compressed at request time. Both formats exist because a phone on a plain-http
URL may only offer gzip. Vite fingerprints everything under `/assets/`, so the
bridge marks those `immutable` and the shell `no-cache`. Measured through a
real browser:

| | over the network |
|---|---|
| cold launch (uncompressed, single bundle) | ~379 KB |
| cold launch (now) | 130 KB |
| re-launch | 0 KB on the critical path |

React and framer-motion are split into their own chunks, so bumping the PWA
re-downloads ~13 KB of app code (and ~21 KB once the CSS and worker rehash too)
instead of the whole bundle.

A re-launch renders from the service worker's cache and revalidates the shell
in the background, so nothing blocks first paint. That costs one launch of
staleness after a deploy: the new worker installs while the old one is still
driving the page, and takes over the next time the app is opened. The trade is
deliberate. Fetching the shell first put a round trip in front of every launch,
which is invisible on the LAN and 200-400 ms over Tailscale, on an app that is
open for ten seconds at a time.

The worker precaches only the latin `woff2` files. Fontsource ships every
subset plus `.woff` fallbacks, and each `@font-face` carries a `unicode-range`,
so the other seven files (83.5 KB) can never render a glyph here; `cache.addAll`
would have fetched them anyway. `scripts/inject-sw.mjs` prints what it left out.

## iOS "Add to Home Screen"

The manifest sets `display: standalone`; `index.html` includes the
`apple-touch-icon` link iOS requires (it ignores manifest icons). For a crisp
Home Screen icon, generate the PNGs once:

```bash
npm i -D sharp && npm run icons
```
