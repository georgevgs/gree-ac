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
| app | `http://gree-ac.local:8481` |

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

```bash
curl http://gree-ac.local:8481/api/health
curl http://gree-ac.local:8481/api/state

ssh gree-ac 'journalctl -fu greehvacd'        # live logs
ssh gree-ac 'systemctl status greehvacd'
ssh gree-ac 'sudo systemctl restart greehvacd'
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

**No Raspberry Pi Connect.** A second remote-access mechanism plus a daemon
using RAM this box does not have. Use Tailscale or a Cloudflare Tunnel if you
ever need remote reach — and never port-forward 8481.

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

## Adding a token later

Only worth it if untrusted devices join the Wi-Fi, or you expose the bridge
over a tunnel.

```bash
openssl rand -hex 32
```

Add `Environment=API_TOKEN=<value>` to
`gree-hvac-rs/deploy/greehvacd.service`, redeploy, then paste the same value
into the PWA's Settings screen on each phone.
