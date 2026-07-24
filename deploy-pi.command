#!/usr/bin/env bash
#
# deploy-pi.command — build and ship the GREE AC bridge to the Raspberry Pi Zero W.
#
# Double-click in Finder, or run from a terminal. Idempotent: safe to re-run
# after any change to the PWA or the Rust bridge.
#
# What it does:
#   1. cross-compiles greehvacd for ARMv6 (arm-unknown-linux-musleabihf, static)
#   2. builds the PWA (Vite), including the .br/.gz siblings the bridge serves as-is
#   3. rsyncs both to the Pi
#   4. installs/refreshes the systemd unit and restarts it
#   5. health-checks /api/health and prints the URL for your phone
#
set -euo pipefail

# --- config ------------------------------------------------------------
PI_HOST="${PI_HOST:-gree-ac.local}"
PI_USER="${PI_USER:-p0mman}"
TARGET="arm-unknown-linux-musleabihf"   # ARMv6 + VFPv2. NOT armv7: that SIGILLs.
REMOTE_PWA="/srv/gree-ac/pwa"
REMOTE_BIN="/usr/local/bin/greehvacd"
PORT="8481"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. toolchain ------------------------------------------------------
bold "==> Checking the ARMv6 toolchain"

command -v cargo >/dev/null || die "cargo not found. Install Rust: https://rustup.rs"

if ! rustup target list --installed | grep -qx "$TARGET"; then
  echo "    adding rustup target $TARGET"
  rustup target add "$TARGET"
fi

# Pick a linker. Preference order:
#   1. Homebrew cross-GCC  — native arm64, fast, no Docker
#   2. cross (Docker)      — works, but the image is amd64 so it runs emulated
LINKER=""
for candidate in arm-unknown-linux-musleabihf-gcc arm-linux-musleabihf-gcc; do
  if command -v "$candidate" >/dev/null; then
    LINKER="$candidate"
    break
  fi
done

BUILD_MODE=""
if [ -n "$LINKER" ]; then
  BUILD_MODE="native"
  echo "    linker: $LINKER"
elif command -v cross >/dev/null && docker info >/dev/null 2>&1; then
  BUILD_MODE="cross"
  warn "    no cross-GCC found; falling back to 'cross' (Docker, emulated amd64 image — slower)"
else
  cat <<'EOF'

No ARMv6 linker available. Install one (takes about a minute):

    brew tap messense/macos-cross-toolchains
    brew install arm-unknown-linux-musleabihf

That is a native Apple Silicon build — no Docker, no emulation. Alternatively,
if you already run Docker Desktop:

    cargo install cross

then re-run this script.
EOF
  exit 1
fi

# --- 2. build the bridge ----------------------------------------------
bold "==> Building greehvacd for $TARGET"

if [ "$BUILD_MODE" = "native" ]; then
  env "CARGO_TARGET_ARM_UNKNOWN_LINUX_MUSLEABIHF_LINKER=$LINKER" \
    cargo build --release -p greehvacd --target "$TARGET" \
    --manifest-path gree-hvac-rs/Cargo.toml
else
  ( cd gree-hvac-rs && cross build --release -p greehvacd --target "$TARGET" )
fi

BIN="gree-hvac-rs/target/$TARGET/release/greehvacd"
[ -f "$BIN" ] || die "build produced no binary at $BIN"

# Prove it is really ARMv6 and static before it ever reaches the Pi. A wrong
# target here shows up as a bare "Illegal instruction" on boot, which is a
# miserable thing to debug remotely.
bold "==> Verifying the binary"
file "$BIN"
if file "$BIN" | grep -q "dynamically linked"; then
  die "binary is dynamically linked — expected a static musl build"
fi
if ! file "$BIN" | grep -qi "ARM"; then
  die "binary is not ARM — check the --target flag"
fi
echo "    size: $(du -h "$BIN" | cut -f1)"

# --- 3. build the PWA --------------------------------------------------
bold "==> Building the PWA"
( cd pwa && npm install --silent && npm run build )
[ -d pwa/dist ] || die "pwa/dist missing after build"

# --- 4. ship -----------------------------------------------------------
bold "==> Shipping to $PI_USER@$PI_HOST"

ssh -o ConnectTimeout=10 "$PI_USER@$PI_HOST" true \
  || die "cannot reach $PI_HOST over ssh. Is the Pi booted and on Wi-Fi?
       Try: ping $PI_HOST — and if mDNS is flaky, re-run with
       PI_HOST=<the Pi's IP> $0"

# Raspberry Pi OS Lite does not always ship rsync.
ssh "$PI_USER@$PI_HOST" "command -v rsync >/dev/null || (sudo apt-get update -qq && sudo apt-get install -y -qq rsync)"

# Static files first, binary last: the old binary keeps serving until the
# moment we restart it, and it never serves a half-copied bundle.
ssh "$PI_USER@$PI_HOST" "sudo mkdir -p '$REMOTE_PWA' && sudo chown -R $PI_USER:$PI_USER /srv/gree-ac"

# Flags kept to the portable subset. macOS 15 ships openrsync, not GNU rsync,
# and it rejects --info=/--partial-dir/etc. -a -z --delete work on both.
rsync -az --delete pwa/dist/ "$PI_USER@$PI_HOST:$REMOTE_PWA/"
# DynamicUser= runs the daemon as a transient uid, so the tree must be
# world-readable for it to serve anything.
ssh "$PI_USER@$PI_HOST" "chmod -R a+rX /srv/gree-ac"
echo "    $(find pwa/dist -type f | wc -l | tr -d ' ') files synced to $REMOTE_PWA"

scp -q "$BIN" "$PI_USER@$PI_HOST:/tmp/greehvacd.new"
scp -q gree-hvac-rs/deploy/greehvacd.service "$PI_USER@$PI_HOST:/tmp/greehvacd.service"

ssh -t "$PI_USER@$PI_HOST" "
  set -e
  sudo install -m 0755 /tmp/greehvacd.new '$REMOTE_BIN'
  sudo install -m 0644 /tmp/greehvacd.service /etc/systemd/system/greehvacd.service
  rm -f /tmp/greehvacd.new /tmp/greehvacd.service
  sudo systemctl daemon-reload
  sudo systemctl enable greehvacd
  sudo systemctl restart greehvacd
"

# --- 5. verify ---------------------------------------------------------
bold "==> Health check"
sleep 3
if ! curl -fsS -m 10 "http://$PI_HOST:$PORT/api/health"; then
  echo
  warn "health check failed. Recent logs:"
  ssh "$PI_USER@$PI_HOST" "sudo journalctl -u greehvacd -n 40 --no-pager"
  exit 1
fi
echo
echo
curl -fsS -m 10 "http://$PI_HOST:$PORT/api/state" || true
echo
echo
bold "Done. Open this on your phone (same Wi-Fi), then Share > Add to Home Screen:"
echo "    http://$PI_HOST:$PORT"
echo
echo "Logs:    ssh $PI_USER@$PI_HOST 'journalctl -fu greehvacd'"
echo "Restart: ssh $PI_USER@$PI_HOST 'sudo systemctl restart greehvacd'"
