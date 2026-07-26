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
| cold launch (now) | 139 KB |
| re-launch | 2.1 KB (just revalidating the shell) |

React and framer-motion are split into their own chunks, so bumping the PWA
re-downloads ~13 KB of app code instead of the whole bundle.

## iOS "Add to Home Screen"

The manifest sets `display: standalone`; `index.html` includes the
`apple-touch-icon` link iOS requires (it ignores manifest icons). For a crisp
Home Screen icon, generate the PNGs once:

```bash
npm i -D sharp && npm run icons
```
