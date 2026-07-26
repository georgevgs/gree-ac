# Pi Zero W runbook

Everything in this file runs on the **Mac** unless a block is explicitly marked
`ON THE PI`. There is almost never a reason to be logged into the Pi.

## Which machine am I on?

| prompt | machine |
|--------|---------|
| `➜  ~` | Mac |
| `p0mman@gree-ac:~ $` | Raspberry Pi |

`exit` always returns you to the Mac.

## The box

| | |
|---|---|
| host | `gree-ac.local` / `192.168.178.73` |
| user | `p0mman` |
| OS | Raspberry Pi OS Lite 32-bit, Trixie, kernel `6.18.34+rpt-rpi-v6` |
| arch | `armv6l` — ARMv6 + VFPv2, **not** ARMv7 |
| AC | `192.168.178.71`, UDP 7000 |
| app | `https://gree-ac.tail6be2e.ts.net` (use this one, at home too) |
| app, LAN fallback | `http://gree-ac.local:8481` |

Give both `.71` and `.73` static leases in the FRITZ!Box.

## First-time setup (already done once)

```bash
# key auth
ssh-copy-id gree-ac

# one-time Pi tuning, then it reboots itself
cd ~/Documents/Dev/gree-ac
scp gree-hvac-rs/deploy/setup-pi.sh gree-ac:
ssh gree-ac 'bash setup-pi.sh && sudo reboot'

# ARMv6 cross-linker: native arm64, no Docker, no emulation
brew tap messense/macos-cross-toolchains
brew install arm-unknown-linux-musleabihf
```

## Deploy (every change)

```bash
cd ~/Documents/Dev/gree-ac
./deploy-pi.command
```

Builds the PWA and the ARMv6 static binary, ships both, restarts the unit,
health-checks `/api/health`. It refuses to ship a binary that is not ARM and
statically linked, because the failure mode on the Pi is a bare
`Illegal instruction` with no other diagnostic.

If mDNS is being unreliable:

```bash
PI_HOST=192.168.178.73 ./deploy-pi.command
```

## Checking on it

Every `/api` route needs the bearer token now, health included, so a bare curl
answers `401`. Read the token back from the drop-in rather than keeping a copy:

```bash
TOK=$(ssh gree-ac "sudo sed -n 's/^Environment=API_TOKEN=//p' \
  /etc/systemd/system/greehvacd.service.d/10-token.conf")

curl -H "Authorization: Bearer $TOK" http://gree-ac.local:8481/api/health
curl -H "Authorization: Bearer $TOK" http://gree-ac.local:8481/api/state

ssh gree-ac 'journalctl -fu greehvacd'        # live logs
ssh gree-ac 'systemctl status greehvacd'
ssh gree-ac 'sudo systemctl restart greehvacd'
ssh gree-ac 'tailscale status'                # is it still on the tailnet?
```

## Why the unusual choices

**32-bit OS.** The Zero W is a BCM2835: ARMv6. Every 64-bit Raspberry Pi OS
image refuses to boot on it. The 32-bit Trixie image is built for ARMv6 — the
`-v6` in the kernel string is the proof.

**`arm-unknown-linux-musleabihf`, not `armv7`.** An ARMv7 build links NEON and
ARMv7-only instructions that this CPU does not have. It compiles, ships, and
then dies with `SIGILL` on first use. musl also makes the binary fully static,
so it does not care which Pi OS release is on the card.

**Cross-compiled, never built on the Pi.** One 1 GHz core and 512 MB RAM
against the tokio + axum dependency tree means hours, and probably an OOM.

**Wi-Fi power save off.** The BCM43438 parks its radio between beacons.
GREE polls over unacknowledged UDP every 3 s, so a parked radio silently drops
replies and the app reads "offline". This is the single most important line in
`setup-pi.sh`.

```bash
ssh gree-ac '/usr/sbin/iw wlan0 get power_save'   # expect: Power save: off
```

The absolute path is not optional: `ssh host 'cmd'` runs a non-interactive
shell whose PATH omits `/usr/sbin`, so a bare `iw` returns "command not found"
even though the package is installed. The same trap makes `sudo somescript.sh`
fail on a relative filename.

**No Raspberry Pi Connect.** Remote reach is Tailscale, and a second mechanism
would only be more surface to keep patched. See
[remote-access.md](remote-access.md). Never port-forward 8481.

**Tailscale runs here despite ARMv6.** The published wisdom is that it does
not: Go 1.21 moved the default `GOARM` from 5 to 7, which is the same SIGILL
trap as the Rust target above, and the usual advice is to pin v1.62.0. That is
stale. Tailscale ships its own Go toolchain, and the current armhf package was
measured on this box at 28.3 MB RSS and 0.10% of one core at idle. It comes
from an apt repo, so `unattended-upgrades` patches it like everything else.
Check before believing either claim:

```bash
ssh gree-ac 'tailscaled --version && systemctl is-active tailscaled'
```

**A network watchdog, installed by `setup-pi.sh`.** Power save off keeps the
radio awake, but it does not stop the BCM43438 from losing the association, and
NetworkManager does not always win it back. Unattended, that is the difference
between controlling the AC from abroad and not controlling it at all. Three
missed pings to the default gateway restart NetworkManager, ten reboot the box,
and the counter lives in `/run` so a reboot restarts the ladder instead of
compounding it.

```bash
ssh gree-ac 'systemctl list-timers net-watchdog.timer --no-pager'
ssh gree-ac 'journalctl -t net-watchdog -n 20 --no-pager'

# Exercise the escalation without any of it actually happening:
ssh gree-ac 'sudo WATCHDOG_DRY_RUN=1 WATCHDOG_GW=192.0.2.1 /usr/local/sbin/net-watchdog.sh'
```

**`AcceptEnv` disabled.** macOS forwards `LC_CTYPE=UTF-8`, which is not a valid
glibc locale name, and every login fills with setlocale warnings. Fixing it
client-side loses to macOS's system-wide `SendEnv LANG LC_*`, so the Pi refuses
the forwarded values instead.

## If it breaks

| symptom | first thing to check |
|---------|---------------------|
| `Illegal instruction` | wrong target — rebuild, confirm `file` says ARM + statically linked |
| `"online": false` | AC IP drifted, or Wi-Fi power save came back on |
| app unreachable, Pi pings | `systemctl status greehvacd`, then the journal |
| Pi not on the network at all | Zero W is 2.4 GHz only — it cannot see a 5 GHz SSID |
| ssh `Connection refused` | still booting; ping works before sshd listens |

Turn up detail when the AC handshake is the suspect — this shows the
ECB→GCM bind fallback:

```bash
ssh gree-ac "sudo systemctl edit greehvacd"   # add Environment=RUST_LOG=debug
```

## The API token

Already set. It lives in a systemd drop-in, **not** in the unit file:

```
/etc/systemd/system/greehvacd.service.d/10-token.conf   # 0600, root
```

`deploy-pi.command` reinstalls `greehvacd.service` on every ship, and that file
is tracked in git, so a token written there would be both committed and
overwritten. Drop-ins survive deploys and stay out of the repo.

Rotate it, then paste the new value into the PWA's Settings on each phone:

```bash
ssh gree-ac '
  TOK=$(openssl rand -hex 32)
  printf "[Service]\nEnvironment=API_TOKEN=%s\n" "$TOK" \
    | sudo tee /etc/systemd/system/greehvacd.service.d/10-token.conf >/dev/null
  sudo chmod 0600 /etc/systemd/system/greehvacd.service.d/10-token.conf
  sudo systemctl daemon-reload && sudo systemctl restart greehvacd
  echo "$TOK"'
```

Confirm the gate is live (`401` is the pass condition):

```bash
curl -so /dev/null -w '%{http_code}\n' http://gree-ac.local:8481/api/state
```
