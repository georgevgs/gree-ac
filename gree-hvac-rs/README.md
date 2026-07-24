# gree-hvac-rs

Rust implementation of the GREE local protocol (Ewpe Smart), ported from
[`gree-hvac-client`](https://github.com/inwaar/gree-hvac-client). This is the
bridge for the app in the parent directory and runs equally well on a Mac, a
Raspberry Pi Zero W, or in Docker.

Three crates:

| crate | what it is | deps |
|-------|------------|------|
| `greehvac` | the protocol backend: UDP transport, ECB/GCM crypto with version fallback, property model. Blocking, runtime-agnostic, **zero async**. | serde, RustCrypto |
| `greehvacd` | daemon wrapping the client in an OS thread and exposing REST + SSE, and optionally serving the built PWA. | tokio, axum |
| `greehvac-probe` | read-only LAN diagnostic that watches raw property codes change. | none |

The device I/O is blocking UDP on a dedicated thread (maps 1:1 to the original
JS state machine). Only the daemon pulls in an async runtime. The web layer
talks to the device thread over an `mpsc` command channel, a shared snapshot,
and a `broadcast` for push.

## Protocol fidelity

Crypto is byte-for-byte identical to the JS library: the known-answer vectors
from the upstream `test/aes.spec.js` are ported as unit tests
(`crypto::tests`) covering both ECB and GCM, encrypt and round-trip.
`cargo test` proves compatibility before you ever touch hardware.

Preserved exactly: the scan, bind (ECB, then GCM on a 500 ms timeout),
bindok, status/cmd sequence, the generic keys, the GCM nonce/AAD, the
`bindok` device-key swap, and the `TemSen - 40` ambient-temperature offset
(0 = unsupported).

Added beyond the JS library: `OutEnvTem` (outdoor sensor temperature), same
`+40` encoding, surfaced as `outdoorTemp` and `null` when the raw value is 0.

## Build & test

```sh
cargo test --workspace                    # KATs, property model, HTTP contract
cargo run  -p greehvacd -- --host 192.168.1.50
cargo run  -p greehvac-probe              # read-only diagnostic, see below
```

`greehvac` compiles on stock stable. `Cargo.lock` keeps `clap` at 4.4 so the
workspace still builds on older toolchains (Debian Bookworm on the Pi ships an
older rustc); newer clap needs the edition-2024 cargo feature.

## Configuration

Flags, environment variables, or a `.env` file in the working directory or any
parent, so the repo-root `.env` configures the daemon wherever it is launched
from.

| flag | env | default | |
|------|-----|---------|--|
| `--host` | `AC_HOST` | `192.168.1.255` | LAN IP of the AC. Unicast beats the broadcast default: give it a static DHCP lease. |
| `--ac-port` | `AC_PORT` | `7000` | GREE local UDP port. |
| `--port` | `PORT` | `8481` | HTTP port for the API and the PWA. |
| `--bind` | `BIND_ADDR` | `0.0.0.0` | HTTP listen address. |
| `--poll-interval-ms` | `POLL_INTERVAL_MS` | `3000` | Status cadence against the AC. |
| `--cors-origin` | `CORS_ORIGIN` | unset | Comma-separated allowlist, or `*`. Unset = no cross-origin access (the PWA is served same-origin). |
| `--public-dir` | `PUBLIC_DIR` | unset | Built PWA to serve (`pwa/dist`). Omit for API-only. |
| `--token` | `API_TOKEN` | unset | Require `Authorization: Bearer <token>` on `/api`. |
| | `RUST_LOG` / `GREE_LOG_LEVEL` | `info` | Log filter. |

## HTTP API

| method | path | body | |
|--------|------|------|--|
| `GET`  | `/api/health` | | `{"status":"ok","ac":{"connected":bool}}` |
| `GET`  | `/api/state` | | the full state DTO (below) |
| `GET`  | `/api/events` | | SSE: the DTO on connect, then on every change |
| `POST` | `/api/power` | `{"on":bool}` | |
| `POST` | `/api/temp` | `{"temp":16-30}` | °C |
| `POST` | `/api/mode` | `{"mode":"auto\|cool\|heat\|dry\|fan_only"}` | |
| `POST` | `/api/fan` | `{"speed":"auto\|low\|mediumLow\|medium\|mediumHigh\|high"}` | |
| `POST` | `/api/swing` | `{"vert"?:...,"hor"?:...}` | vert: 12 positions, hor: 8 |
| `POST` | `/api/option` | `{"key":...,"value":...}` | booleans and small enums |
| `POST` | `/api/properties` | `{"mode":"heat","temperature":22}` | raw escape hatch: any protocol property by name |

Every write answers with the fresh DTO, so a client can apply the response
directly. Writes are optimistic by one round trip: UDP has no ack, so the
response echoes what was sent and the device's confirmation follows on
`/api/events` moments later. Every POST must carry
`Content-Type: application/json`; anything else is refused with `415`. Errors
are `{"error":"..."}`: `400` for a bad value (the message lists what would
have been accepted), `503` when the AC is unreachable, and the same envelope
on `415`, `401`, and unknown `/api` routes.

```json
{
  "online": true, "power": true, "mode": "cool", "targetTemp": 24,
  "currentTemp": 22, "outdoorTemp": 31, "fanSpeed": "auto",
  "swingVert": "default", "swingHor": "default", "air": "off",
  "lights": true, "turbo": false, "quiet": "off", "health": false,
  "xfan": false, "sleep": false, "powerSave": false, "safetyHeating": false,
  "unit": "celsius", "updatedAt": "2026-07-22T18:04:05.123Z"
}
```

`online` is `false` before the first connection and whenever the device stops
responding (powered off, off Wi-Fi). The other fields keep the last known
settings so the UI can grey them out rather than blank the screen. Silence for
~3 poll intervals triggers an offline push and a reconnect. `currentTemp` is
`0` when the unit reports no ambient sensor (the JS library's convention);
`outdoorTemp` is `null` when there's no outdoor sensor.

`/api/properties` names properties as `power, mode, temperatureUnit,
temperature, currentTemperature, fanSpeed, air, blow, health, sleep, lights,
swingHor, swingVert, quiet, turbo, powerSave, safetyHeating, outdoorTemp`; the
last two of those are read-only. Which of these actually do something varies
by unit (see `../docs/reference-unit.md` for a worked example); do a first-run
`GET /api/state` to see what your unit reports.

If `--token` is set, every `/api` request must carry
`Authorization: Bearer <token>` (`EventSource` can't send headers, so
`/api/events?token=...` is accepted too).

## Serving the UI

Point `PUBLIC_DIR` at a built SPA and the daemon serves it beneath the API,
with an `index.html` fallback: one process, one URL, no separate web host.

Static files are served **precompressed**: if a `.br`/`.gz` sibling exists
next to a file and the client accepts that encoding, it is sent as-is.
Nothing is compressed at request time, which is deliberate. On a Pi Zero W
that would be the only part of this daemon capable of noticeable CPU load.
`../pwa`'s build step writes those siblings.

Fingerprinted assets under `/assets/` are marked `immutable`; the shell
(`index.html`, `sw.js`, the manifest, icons) is `no-cache` so a rebuilt app
still reaches an installed home-screen launcher.

The PWA in `../pwa` is the client: `src/api/acClient.ts` wraps the endpoints
above, and `src/hooks/useACState.ts` subscribes to `/api/events` and falls
back to polling when the stream is down.

## Probe: finding undocumented property codes

`greehvac` models 18 property codes; a unit may carry more under names nobody
has mapped. The probe sends only `status` requests, never `cmd`, so it cannot
change the AC. It prints whichever raw code changes when you press a button on
the remote.

```sh
cargo run -p greehvac-probe                       # AC_HOST from .env
cargo run -p greehvac-probe -- --host 192.168.1.50
cargo run -p greehvac-probe -- --codes FooBar,BazQux   # append candidates
cargo run -p greehvac-probe -- --only Pow,Mod,SetTem   # REPLACE the column list
```

`--only` matters: a unit truncates its reply when asked for too many columns
at once (a ~90-column request came back with only the 17 core codes, dropping
even `OutEnvTem`, which the reference unit does support). Probe small focused
sets to tell "unsupported" apart from "truncated".

## Cross-compile for the Pi Zero W

The Zero W is **ARMv6** + VFPv2. Do **not** use an `armv7`/`armhf` target; the
binary will `SIGILL` on the first NEON/ARMv7 instruction. The target is
`arm-unknown-linux-musleabihf`: ARMv6, and statically linked, so the binary
carries no glibc-version coupling to whatever Pi OS release is on the card.

Never build on the Pi. One 1 GHz core and 512 MB RAM against the tokio + axum
dependency tree means hours, and likely an OOM.

`../deploy-pi.command` does all of this — build, verify, ship, restart,
health-check. Use it rather than the raw commands below; it asserts the output
ELF is ARM and statically linked before shipping, because the failure mode of a
wrong target is a bare `Illegal instruction` on the Pi with no other clue.

By hand, on Apple Silicon:

```sh
brew tap messense/macos-cross-toolchains
brew install arm-unknown-linux-musleabihf         # native arm64, no Docker
rustup target add arm-unknown-linux-musleabihf

CARGO_TARGET_ARM_UNKNOWN_LINUX_MUSLEABIHF_LINKER=arm-unknown-linux-musleabihf-gcc \
  cargo build --release -p greehvacd --target arm-unknown-linux-musleabihf

file target/arm-unknown-linux-musleabihf/release/greehvacd
# want: ELF 32-bit LSB executable, ARM, EABI5 ... statically linked
```

[`cross`](https://github.com/cross-rs/cross) also works and needs no brew tap,
but its ARMv6 image is amd64-only, so on Apple Silicon it builds under QEMU
emulation — correct output, considerably slower, and Docker must be running.

RustCrypto is pure Rust, so there is no OpenSSL to cross-link. That is the main
reason this stays a one-command build instead of a toolchain project.

Give the AC a static DHCP lease and pass it via `--host`; unicast is more
reliable than the `.255` broadcast default once you know the address.

## systemd

`../deploy-pi.command` installs and restarts the unit for you. By hand: copy
`deploy/greehvacd.service` to `/etc/systemd/system/`, edit `AC_HOST`, then:

```sh
sudo systemctl enable --now greehvacd
```

`deploy/setup-pi.sh` is the one-time host tuning that belongs alongside it —
most importantly disabling Wi-Fi power save, without which the radio parks
between beacons and silently drops the AC's UDP replies. Read the comments
before editing it: it deliberately does **not** touch sshd.

## Docker

`Dockerfile` builds a static musl binary into a bare Alpine image. Run it with
host networking so GREE's UDP LAN traffic reaches the AC; see
`../docker-compose.yml`.
