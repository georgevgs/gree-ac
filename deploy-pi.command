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
TARGET="arm-unknown-linux-musleabihf"   # ARMv6 + VFPv2. NOT armv7: that SIGILLs.
REMOTE_PWA="/srv/gree-ac/pwa"
REMOTE_BIN="/usr/local/bin/greehvacd"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Where this house's Pi is and what it is called live in the untracked .env,
# never in this file: it is committed to a public repo, and an account name plus
# an address is free reconnaissance for anyone who later reaches the tailnet.
# Environment wins over .env so a one-off `PI_HOST=… ./deploy-pi.command` works.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
PI_HOST="${PI_HOST:-gree-ac.local}"
PI_USER="${PI_USER:-}"
# Set after sourcing .env, not before: the daemon on the Pi takes its port from
# the unit file, so a PORT meant for a local `cargo run` must not retarget the
# health check at a port nothing is listening on.
PORT="8481"
[ -n "$PI_USER" ]         || die "PI_USER is not set. Add the Pi's login name to .env (PI_USER=...)."
[ -n "${AC_HOST:-}" ]     || die "AC_HOST is not set. Add the AC's LAN IP to .env (AC_HOST=...)."

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
( cd pwa && npm ci --silent && npm run build )
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

# The unit file is tracked in git and reinstalled here on every ship, so a
# token in it would be both committed and overwritten. Refuse to deploy rather
# than ship a secret to a public repo.
if grep -qE '^[[:space:]]*Environment=API_TOKEN=' gree-hvac-rs/deploy/greehvacd.service; then
  die "API_TOKEN is set in the tracked unit file. Move it to a root-only drop-in
     (/etc/systemd/system/greehvacd.service.d/10-token.conf) and remove the line;
     the unit file's own comment has the command."
fi

# Staged under the deploy user's home, not /tmp: on a Pi with more than one
# account, anything in world-writable /tmp can be swapped between the copy and
# the `sudo install` that follows it.
STAGE="/home/$PI_USER/.cache/gree-ac"
ssh "$PI_USER@$PI_HOST" "mkdir -p '$STAGE' && chmod 700 '$STAGE'"
scp -q "$BIN" "$PI_USER@$PI_HOST:$STAGE/greehvacd.new"

# The tracked unit carries a placeholder for the AC's address; fill it in from
# .env on the way out so the real one exists only on this Mac and on the Pi.
UNIT_TMP="$(mktemp -t greehvacd.service)"
trap 'rm -f "$UNIT_TMP"' EXIT
sed "s|__AC_HOST__|$AC_HOST|" gree-hvac-rs/deploy/greehvacd.service > "$UNIT_TMP"
if grep -q '__AC_HOST__' "$UNIT_TMP"; then
  die "failed to substitute AC_HOST into the unit file"
fi
scp -q "$UNIT_TMP" "$PI_USER@$PI_HOST:$STAGE/greehvacd.service"

ssh -t "$PI_USER@$PI_HOST" "
  set -e
  sudo install -m 0755 '$STAGE/greehvacd.new' '$REMOTE_BIN'
  sudo install -m 0644 '$STAGE/greehvacd.service' /etc/systemd/system/greehvacd.service
  rm -f '$STAGE/greehvacd.new' '$STAGE/greehvacd.service'
  sudo systemctl daemon-reload
  sudo systemctl enable greehvacd
  sudo systemctl restart greehvacd
"

# --- 5. verify ---------------------------------------------------------
bold "==> Health check"
sleep 3

# Every /api route sits behind the bearer token when one is configured, health
# included, so an unauthenticated check here would just assert a 401 forever.
# The token lives in a systemd drop-in on the Pi and deliberately never in the
# tracked unit file, so read it back over ssh. Checking it this way also proves
# the token still works after the restart, which is the thing most likely to
# have broken.
TOKEN="$(ssh "$PI_USER@$PI_HOST" \
  "sudo sed -n 's/^Environment=API_TOKEN=//p' /etc/systemd/system/greehvacd.service.d/*.conf 2>/dev/null | tail -1" \
  || true)"

# The checks below carry the bearer token, so prefer the tailnet HTTPS origin:
# the LAN URL is plain HTTP, and anyone holding the Wi-Fi PSK can read a token
# off the air. `/` is the app shell, which sits outside the token gate, so it
# probes reachability without needing to authenticate.
TSNAME="$(ssh "$PI_USER@$PI_HOST" \
  "tailscale status --json 2>/dev/null | sed -n 's/.*\"DNSName\": \"\\([^\"]*\\)\\.\",*/\\1/p' | head -1" \
  || true)"

API_BASE="http://$PI_HOST:$PORT"
if [ -n "$TSNAME" ] && curl -fsS -m 5 -o /dev/null "https://$TSNAME/" 2>/dev/null; then
  API_BASE="https://$TSNAME"
fi

if [ -n "$TOKEN" ]; then
  echo "    authenticating with the token from the Pi's drop-in"
  case "$API_BASE" in
    https://*) ;;
    *) warn "    this Mac isn't on the tailnet; the token crosses the LAN over plain HTTP" ;;
  esac
fi

# Explicit branch rather than a "${ARGS[@]}" array: macOS still ships bash 3.2,
# where expanding an empty array under `set -u` aborts the script.
# The token goes in on stdin, never in argv, where `ps` would show it to every
# account on this machine for the life of the request.
api() {
  if [ -n "$TOKEN" ]; then
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
      | curl -fsS -m 10 --config - "$API_BASE$1"
  else
    curl -fsS -m 10 "$API_BASE$1"
  fi
}

if ! api /api/health; then
  echo
  warn "health check failed. Recent logs:"
  ssh "$PI_USER@$PI_HOST" "sudo journalctl -u greehvacd -n 40 --no-pager"
  exit 1
fi
echo
echo
api /api/state || true
echo
echo

# The tailnet name is the origin to install from: it is the only one that works
# both at home and away, and it is HTTPS, so the service worker registers.
# (Looked up above, before the health check, so the token rides HTTPS.)
if [ -n "$TSNAME" ]; then
  bold "Done. Open this on your phone, then Share > Add to Home Screen:"
  echo "    https://$TSNAME"
  echo
  echo "    (works on the home Wi-Fi and over cellular; install this one, not the LAN URL)"
  echo "    LAN fallback, same Wi-Fi only: http://$PI_HOST:$PORT"
else
  bold "Done. Open this on your phone (same Wi-Fi), then Share > Add to Home Screen:"
  echo "    http://$PI_HOST:$PORT"
fi
echo
echo "Logs:    ssh $PI_USER@$PI_HOST 'journalctl -fu greehvacd'"
echo "Restart: ssh $PI_USER@$PI_HOST 'sudo systemctl restart greehvacd'"
