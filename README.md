# GREE AC Control

Self-hosted local control for **GREE-based air conditioners** — no cloud, no
vendor app. A React PWA talks to a small Rust bridge on the LAN, which speaks
the **GREE local protocol** (Ewpe Smart, UDP port 7000) directly to the AC.

**Works with any unit that pairs with the Ewpe Smart / GREE+ app**, which
includes hardware sold under many brands: GREE, Tosot, Cooper & Hunter,
Sinclair, Inventor, Argo, Daitsu, **Toyotomi**, and other rebrands. The
reference unit this project was built and probed against is a Toyotomi Umi
UTN/UTG-12CH; unit-specific findings below are labeled as such.

> **Protocol note — GREE, not Tuya.** If your unit pairs with Ewpe Smart or
> GREE+, it speaks GREE's local UDP protocol and this project applies. If it
> pairs only with a Tuya-based app, it does not. Firmware ≳ v1.21 uses
> **AES-GCM** encryption, older firmware AES-ECB; the bridge tries ECB first
> and falls back to GCM automatically, so both are handled for you.

## Architecture

```
PWA (React + TS, "Add to Home Screen")
  └── fetch + SSE → greehvacd, the Rust bridge (binary, container, or systemd)
                          │
                    GREE protocol → AC on LAN, UDP port 7000
```

- The PWA is a thin REST client. It never sees the GREE protocol — the bridge
  returns friendly JSON (`{ power, targetTemp, mode, fanSpeed, ... }`).
- The bridge keeps one persistent, polled connection to the AC and reconnects
  with backoff on drops. Changes are **pushed** to the app over SSE, so a change
  made on the physical remote shows up immediately.
- The bridge also serves the built PWA, so the whole app is one process and one
  URL on the LAN.
- Remote access (outside the home LAN) is via whatever the host already
  uses — Tailscale or Cloudflare Tunnel.

```
.
├── gree-hvac-rs/    Rust workspace: protocol crate + bridge daemon + probe
├── pwa/             React + Vite + Tailwind PWA
├── .env             bridge config (AC_HOST, PORT, PUBLIC_DIR, …)
└── docker-compose.yml
```

Node is a **build-time** dependency only (Vite builds the PWA). Nothing in the
running system needs it.

---

## Phase 0 — Onboarding (do this first)

GREE binds **locally** — there is no cloud account, no `local_key`, no DPS
schema to extract. You only need the unit's LAN IP.

1. **Pair the AC** with the **Ewpe Smart** app (or confirm it's already on your
   WiFi). If it pairs with "Toyotomi Home"/Tuya instead, this project does not
   apply — stop and reassess.
2. **Find the AC's IP** (router DHCP table, or `nmap -p 7000 192.168.1.0/24`).
3. **Set a DHCP reservation** for that IP in your router so it never drifts.
4. That's it — the bridge derives the device key automatically on first connect.

Reference unit (fill in yours):

| Field | Value |
|-------|-------|
| Model | Toyotomi Umi UTN/UTG-12CH (12000 BTU, A+++/A+++) — a GREE rebrand |
| WiFi firmware | v1.45 (→ AES-GCM) |
| LAN IP | _set a DHCP reservation, then put it in `.env` as `AC_HOST`_ |

---

## Phase 1 — Bridge

Needs a Rust toolchain ([rustup](https://rustup.rs)); nothing else.

```bash
cp .env.example .env                        # set AC_HOST to the AC's LAN IP
cd gree-hvac-rs
cargo test --workspace                      # crypto KATs + HTTP contract, no hardware
cargo run -p greehvacd                      # http://localhost:8481
```

`cargo test` is worth running first: it proves the AES-ECB/GCM implementation is
byte-identical to the reference one before you point it at hardware.

**Verify it talks to the unit before touching the UI** (this is the
highest-risk step — encryption/param correctness):

```bash
# Read state
curl http://localhost:8481/api/state

# Turn on, set 24°C, cool mode
curl -X POST http://localhost:8481/api/power -H 'content-type: application/json' -d '{"on":true}'
curl -X POST http://localhost:8481/api/temp  -H 'content-type: application/json' -d '{"temp":24}'
curl -X POST http://localhost:8481/api/mode  -H 'content-type: application/json' -d '{"mode":"cool"}'
```

If `/api/state` shows `"online": false` or connects then drops, set
`GREE_LOG_LEVEL=debug` in `.env` and watch the bind handshake.

### REST API

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET  | `/api/health` | — | `{ status, ac: { connected } }` |
| GET  | `/api/state`  | — | full friendly state DTO |
| GET  | `/api/events` | — | SSE: the DTO on connect, then on every change |
| POST | `/api/power`  | `{ "on": boolean }` | |
| POST | `/api/temp`   | `{ "temp": 16-30 }` | °C |
| POST | `/api/mode`   | `{ "mode": "auto\|cool\|heat\|dry\|fan_only" }` | |
| POST | `/api/fan`    | `{ "speed": "auto\|low\|mediumLow\|medium\|mediumHigh\|high" }` | |
| POST | `/api/swing`  | `{ "vert"?: swingVert, "hor"?: swingHor }` | vert: 12 positions · hor: 8 positions |
| POST | `/api/option` | `{ "key": OptionKey, "value": ... }` | see keys below |
| POST | `/api/properties` | `{ "mode": "heat", "temperature": 22 }` | raw escape hatch: any protocol property by name |

`/api/option` keys and value types:

| key | value |
|-----|-------|
| `lights` `turbo` `sleep` `xfan` `health` `powerSave` `safetyHeating` | `boolean` |
| `quiet` | `"off" \| "mode1" \| "mode2" \| "mode3"` |
| `air` (fresh-air valve) | `"off" \| "inside" \| "outside" \| "mode3"` |
| `unit` | `"celsius" \| "fahrenheit"` |

Swing values — vert: `default full fixedTop fixedMidTop fixedMid fixedMidBottom fixedBottom swingTop swingMidTop swingMid swingMidBottom swingBottom` · hor: `default full fixedLeft fixedMidLeft fixedMid fixedMidRight fixedRight fullAlt`.

Every write responds with the fresh state DTO — optimistically, by one round
trip: UDP has no ack, so the response echoes what was sent and the device's
confirmation follows on `/api/events` moments later. Errors are
`{ "error": "…" }` with `400` for a bad value (the message lists what would have
been accepted) and `503` when the AC is unreachable.

### No consumption data

This unit reports **no power, current, or compressor frequency** over the GREE
protocol. Probing confirmed it (see "Probing for undocumented codes" — the device
only ever returns its 17 core codes; every energy/frequency candidate is absent).
The bridge used to ship a modelled estimate, but checked against a real meter it
was too far off to be useful, so it was removed entirely. **For real numbers, add
an inline meter** (Shelly EM with a CT clamp on the AC circuit, or a Shelly PM
plug).

**Feature notes** (GREE protocol names vs. what they do on this unit):

- `health` — GREE's "Cold plasma / anion generator." On the Umi this **is the
  ionizer** (the headline air-quality feature). The PWA labels it "Ionizer".
- `xfan` (GREE `Blo`) — keeps the fan running a few minutes after shutdown to
  **dry the coil** and prevent mildew. Cool/Dry modes only. Marketed as "Auto Clean".
- `sleep` — gradually drifts the setpoint overnight (warmer in Cool, cooler in Heat).
- `powerSave` (GREE `SvSt`) — energy-saving compressor cap. Labeled "Eco".
- `quiet` — progressively lower fan-noise ceilings (`mode1`→`mode3`, quietest).
  Not available in Dry/Fan. `turbo` (max fan) is its opposite; don't expect both.
- `safetyHeating` (GREE `StHt`) — **8°C anti-freeze heating**; holds an empty
  room near 8°C so it doesn't freeze. Documented Umi feature.
- `air` (fresh-air valve) — present in the GREE protocol, but the 12CH is a
  standard wall split with **no physical fresh-air damper**. On this unit "fresh
  air" is a marketing term for the 56°C self-clean, not ventilation. The API
  still accepts it (`inside` = recirculate, `outside` = exhaust, `mode3` = both)
  in case a future unit has the damper, but the PWA **omits the control** since
  it does nothing here.
- `outdoorTemp` (GREE `OutEnvTem`, read-only) — outdoor sensor temperature in
  the state DTO. No public library models this code; the bridge fetches and
  decodes it as a first-class property (`+40` encoded, same scheme as `TemSen`).
  Confirmed live on the 12CH. `null` when the unit reports no sensor.
- **Not exposed / needs confirmation** — the probe (below) found this unit also
  reports `AntiDirectBlow`, `AutoClean`, `UvcControl`, `LigSen`, `SlpMod`,
  `DwatSen`. It does **not** report any `SelfClean`/`iFeel` code. The cleaning/UV
  ones (`AutoClean`, `UvcControl`) are write-actuated cycles — press the matching
  button on the remote while the probe runs to confirm which is which before
  wiring a control.

### Probing for undocumented codes

The bridge models 18 property codes; a unit may carry more under names nobody
has mapped. `greehvac-probe` is a **read-only** LAN diagnostic that hunts for
them — it reuses the same scan/bind/AES-GCM handshake as the bridge, sends
`status` requests for a broadened column list, and prints whichever raw code
changes when you press a button on the AC.

```bash
cd gree-hvac-rs
cargo run -p greehvac-probe                 # AC_HOST from .env
# …then press "Self Clean" on the physical remote and watch for a CHANGED line.
# Add more candidate codes without editing the file:
cargo run -p greehvac-probe -- --codes FooBar,BazQux
# Or REPLACE the whole column list — this unit truncates a very large request
# back to its 17 core codes, so probe a small focused set to test cleanly:
cargo run -p greehvac-probe -- --only Pow,Mod,SetTem,TemSen,CmpFrq,Freq,Watt,EnLen,Curr
```

The candidate list also includes energy/compressor-frequency codes (`Watt`,
`EnLen`, `CmpFrq`, `Freq`, …) — see the "No energy or compressor data" finding
below for what that turned up.

It only ever sends `status` (never `cmd`), so it cannot change the AC, and it
needs no internet. If a code flips (e.g. `0 -> 1`), wiring it into the bridge is
a small change mirroring any existing toggle. If nothing flips, the feature
isn't reachable over WiFi on this unit — it's remote/IR-only — and there's
nothing to add.

**What the probe found on this unit (UTN/UTG-12CH, firmware v1.45).** Beyond the
~17 codes the public GREE libraries model, this unit also reports:

| Code | Meaning | Status |
|------|---------|--------|
| `OutEnvTem` | Outdoor temperature (read-only sensor) | **Wired** → `outdoorTemp` in the DTO |
| `Buzzer_ON_OFF` | Command-beep control (app's "Sound") | Readable, but **not writable** — see below |
| `AntiDirectBlow` | Deflect airflow away from people | Reported (0); no remote/app button — inert |
| `AutoClean` | Auto-clean / coil-dry cycle | Reported (0); no remote/app button — inert |
| `UvcControl` | UV-C sterilization control | Reported (0); no remote/app button — inert |
| `LigSen` | Display auto-dim light sensor | Reported (0) |
| `SlpMod` | Sleep-curve mode selector | Reported (0) |
| `DwatSen` | Drain-water fault sensor | Reported (0) |

Findings from mapping the physical remote and the Ewpe/GREE+ app against the
live protocol (press-a-button-and-watch-what-flips):

- **Every control the remote and the vendor app expose, the bridge already
  covers** (power, mode, fan, quiet, turbo, swings incl. fixed angles, light,
  X-Fan, health/ionizer, 8°C heat, eco, sleep, °C/°F).
- **No `SelfClean`/`iFeel`** code exists here — i-Sense produced zero protocol
  change (remote-only), and neither the remote nor the app has a self-clean
  button. `AntiDirectBlow`/`AutoClean`/`UvcControl` are reported but have no
  button in either the remote or the app, so they're inert — not wired (that's
  the fresh-air lesson: a reported code that moves nothing).
- **`Buzzer_ON_OFF`** (the app's "Sound" beep toggle) is readable and flips when
  toggled from the app, but writes to it via the generic path **don't stick** —
  not standalone, not bundled with a command. It needs the exact Ewpe payload
  (probably a `BuzzerCtrl` companion), which isn't cracked, so it's deliberately
  **not exposed** rather than shipped as a dead toggle.
- **No energy or compressor data.** The unit reports no power, current, voltage,
  or compressor-frequency code — every candidate (`Watt`, `EnLen`, `Curr`,
  `CmpFrq`, `Freq`, `OutFrq`, …) is absent, and a large multi-column `status`
  request just gets truncated back to the 17 core codes. So real consumption
  **can't be read over WiFi** (see "No consumption data" above). Accurate metering needs
  external hardware (Shelly EM/PM).

### Security model

The default posture is **trusted-LAN**: no auth, CORS open. That is fine for a
private home Wi-Fi and nothing else. Concretely:

- **Never port-forward the bridge to the internet.** For remote access use
  Tailscale or Cloudflare Tunnel (with access control) instead.
- **Set `API_TOKEN`** whenever anyone untrusted can join the network, or when
  the bridge is reachable over a tunnel. Every `/api` request then needs
  `Authorization: Bearer <token>` (or `?token=` for `EventSource`, which cannot
  send headers — note query tokens can land in access logs). The comparison is
  constant-time. 401s use the same `{"error": …}` envelope as other failures.
- **Open CORS + no token means LAN drive-by is possible**: any website open on
  a device inside your network could script the API. Browsers increasingly
  block public→private requests (Private Network Access), but don't rely on
  it — a token closes this properly, and `CORS_ORIGIN` can pin the UI origin.
- The daemon logs a startup warning whenever `/api` runs without auth.
- Nothing in this repo contains device secrets: the GREE "generic" AES keys in
  the crypto layer are protocol constants (public knowledge, required by every
  client implementation), and the per-device key is derived at bind time and
  held only in memory.

---

## Phase 2 — PWA

```bash
cd pwa
cp .env.example .env         # set VITE_BRIDGE_URL to the bridge's URL
npm install
npm run dev                  # http://localhost:5173 (also on your LAN IP)
```

- `VITE_BRIDGE_URL` — the bridge's LAN IP or Tailscale hostname. Leave **empty**
  if the bridge serves the PWA (same origin).
- `VITE_DEVICE_NAME` — what the app calls the unit (the big name in the header
  and the device card in Settings), e.g. `Umi` or `Living room`. Unset = the
  generic "AC".
- State arrives over SSE (`/api/events`) as it changes, so the UI reflects the
  physical remote within milliseconds. Polling `/api/state` stays on as a
  fallback — every 15s while the stream is healthy, every 2s when it isn't.
- The service worker (production only) caches the **app shell** for offline
  install — it never caches live AC state. Note it only registers in a *secure
  context*: over a plain `http://192.168.x.x` LAN URL browsers don't expose the
  API at all, so on the phone the HTTP cache below is what actually does the
  work.

### Load performance (it matters — the bridge may be a Pi Zero W)

`npm run build` writes `.br` and `.gz` siblings for every compressible file, and
the bridge serves them straight off disk — no compression at request time, which
would be the one thing that could actually load a Pi's CPU. Both formats are
produced because a phone on a plain-http URL may only offer gzip.

Vite fingerprints everything under `/assets/`, so the bridge marks those
`immutable` and the shell `no-cache`. Measured through a real browser:

| | over the network |
|---|---|
| cold launch (uncompressed, single bundle) | ~379 KB |
| cold launch (now) | **139 KB** |
| re-launch | **2.1 KB** (just revalidating the shell) |

React and framer-motion are split into their own chunks, so bumping the PWA
re-downloads ~11 KB of app code instead of the whole bundle.

### iOS "Add to Home Screen"

The manifest sets `display: standalone`; `index.html` includes the
`apple-touch-icon` link iOS requires (it ignores manifest icons). For a crisp
Home Screen icon, generate the PNGs once:

```bash
cd pwa
npm i -D sharp && npm run icons     # writes versioned icon-192/512 + apple-touch-icon PNGs
```

---

## Phase 3a — Run on a Mac (on-site only, no server)

**This is the setup in use for the vacation-home deployment** — there's no
always-on server. The bridge runs on a Mac that's at the house, and control
happens from a phone on the same Wi-Fi. No cloud, no tunnel: leave the house and
(by design) the AC is no longer reachable. Controlling it remotely — e.g.
pre-cooling before you arrive — needs a device that *stays* at the house; see the
Unraid/Pi path in Phase 3b.

**One-time:**

1. Install [Rust](https://rustup.rs) once (`curl --proto '=https' --tlsv1.2 -sSf
   https://sh.rustup.rs | sh`). The launcher builds the bridge on first run.
2. Reserve the AC's IP in your router (e.g. FRITZ!Box: *Heimnetz → Netzwerk →*
   the AC device *→* edit *→ "always assign this network device the same IPv4
   address"*), and put that IP in the repo-root `.env` as `AC_HOST`.
3. Build the app so the bridge can serve it, and point `PUBLIC_DIR` at it:
   ```bash
   cd pwa && npm run build     # VITE_BRIDGE_URL must be EMPTY (= same origin)
   ```
   `.env` already sets `PUBLIC_DIR=…/pwa/dist`, so the bridge serves the app
   itself — one URL, no separate web host.

**Every time — double-click `run-ac.command`** in the project root. It starts the
bridge and prints a URL like `http://<this-macs-lan-ip>:8481`. On your **phone**
(same Wi-Fi) open that URL → *Share → Add to Home Screen*. Keep the Terminal
window open; close it to stop.

The first launch compiles the bridge (a few minutes) and builds the PWA; every
launch after that is instant.

- Build the app **same-origin** (`VITE_BRIDGE_URL=` empty). `http://localhost:8481`
  would break on the phone, where "localhost" is the phone itself.
- The bridge listens on `0.0.0.0`, so any device on the Wi-Fi reaches it. The API
  has **no auth** — fine on a trusted home Wi-Fi; never forward the port to the
  internet.

---

## Phase 3b — Deploy on Unraid, a Pi, or anything always-on

```bash
cd pwa && npm run build && cd ..   # the container mounts pwa/dist read-only
docker compose up -d --build       # builds a static musl binary into bare Alpine
```

- Runs with `network_mode: host` so GREE's UDP LAN traffic works reliably.
- Serve the PWA either from the bridge (the compose file mounts `pwa/dist` and
  sets `PUBLIC_DIR`) or from any static host reachable over your tunnel.
- **Remote access:** reuse the Tailscale or Cloudflare Tunnel already on the
  box — don't introduce a second mechanism.
- **No Docker?** Cross-compile the binary and run it under systemd instead —
  `gree-hvac-rs/README.md` covers the Pi Zero W (ARMv6) target and ships a
  `deploy/greehvacd.service` unit. Set `API_TOKEN` if it will be reachable
  beyond a trusted LAN.

---

## Out of scope (v1)

- HomeKit/Siri (could bridge via Homebridge later — separate project)
- Scheduling / energy automation
- Energy metering (the unit exposes none over WiFi; a modelled estimate was
  tried and removed — too inaccurate. Real metering needs external hardware
  like a Shelly EM/PM)
- Multi-user auth on the bridge

## Credits

Local protocol implemented in `gree-hvac-rs/`, a Rust port of
[`gree-hvac-client`](https://github.com/inwaar/gree-hvac-client) — whose AES
known-answer vectors it carries as tests, so wire compatibility is proven rather
than assumed. Protocol reverse-engineering:
[tomikaa87/gree-remote](https://github.com/tomikaa87/gree-remote).
