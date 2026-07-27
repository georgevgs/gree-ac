#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# GREE AC bridge — on-site launcher (double-click me)
#
# Starts the bridge on this Mac. The bridge talks to the AC over the home WiFi
# AND serves the control app, so there's a single URL to open on your phone.
# Keep the Terminal window that opens; close it (or press Ctrl-C) to stop.
#
# Works only while this Mac is on the same WiFi as the AC (on-site control).
# ─────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"
ROOT="$(pwd)"

# Point the bridge at the built PWA (robust to wherever this repo lives).
export PUBLIC_DIR="$ROOT/pwa/dist"

# cargo lives in ~/.cargo/bin, which a double-clicked Terminal may not have on
# its PATH yet.
export PATH="$HOME/.cargo/bin:$PATH"
BRIDGE="$ROOT/gree-hvac-rs/target/release/greehvacd"

if [ ! -x "$BRIDGE" ] && ! command -v cargo >/dev/null 2>&1; then
  echo ""
  echo "  Rust isn't installed, so the bridge can't be built. Install it once:"
  echo "      curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  echo "  then run this again."
  echo ""
  read -r -p "  Press Return to close." _
  exit 1
fi

# Build on first run, and REBUILD when sources changed since the last build —
# otherwise a double-click after pulling changes silently launches stale code.
if [ ! -f pwa/dist/index.html ]; then
  echo "First run — building the app…"
  ( cd pwa && npm ci && npm run build )
elif command -v npm >/dev/null 2>&1 \
  && [ -n "$(find pwa/src pwa/public pwa/index.html pwa/package.json pwa/vite.config.ts \
             -newer pwa/dist/index.html -print 2>/dev/null | head -1)" ]; then
  echo "App changed — rebuilding…"
  ( cd pwa && npm run build )
fi

# cargo itself is the freshness check for the bridge: a no-op build returns in
# about a second when nothing changed, so run it whenever the toolchain exists.
if command -v cargo >/dev/null 2>&1; then
  if [ ! -x "$BRIDGE" ]; then
    echo "First run — building the bridge (a few minutes, once)…"
  fi
  ( cd gree-hvac-rs && cargo build --release -p greehvacd )
fi

# Best-effort LAN IP for the "open this on your phone" hint (en0=Wi-Fi on a Mac).
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 'this-mac-ip')"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-8481}"

# Preflight: if the bridge is already running (e.g. an earlier window), bail out
# with a clear message instead of a confusing "address in use" crash.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo ""
  echo "  A bridge is already running on port $PORT."
  echo "  It's probably an earlier window — just open http://$LAN_IP:$PORT,"
  echo "  or close that other Terminal window first, then run this again."
  echo ""
  read -r -p "  Press Return to close." _
  exit 0
fi

echo ""
echo "  AC bridge is starting…"
echo "  ────────────────────────────────────────────"
echo "  On your phone (same Wi-Fi), open:"
echo "      http://$LAN_IP:$PORT"
echo "  Then tap Share → Add to Home Screen."
echo ""
echo "  Leave this window open. Close it to stop the AC control."
echo "  ────────────────────────────────────────────"
echo ""

# caffeinate: the bridge must answer the phone instantly at all times, so hold
# a power assertion while it runs — otherwise a MacBook idle-sleeps (or naps
# the Terminal) and the first tap after a quiet spell waits for the host to
# wake instead of the AC. -i blocks idle sleep, -s blocks sleep on AC power.
exec caffeinate -is "$BRIDGE"
