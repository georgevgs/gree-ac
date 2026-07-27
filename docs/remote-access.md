# Remote access

Reaching the AC from outside the house, so you can start cooling before you
arrive. The bridge speaks GREE's local UDP protocol and must stay on the AC's
LAN, so "remote access" means reaching the Pi, never moving the bridge.

**Tailscale, on the Pi.** No inbound port on the router, no dynamic DNS, no
per-device config files, and `tailscale serve` issues a real certificate so the
app finally runs in a secure context.

## The box

| | |
|---|---|
| tailnet name | `gree-ac.tail6be2e.ts.net` |
| app | `https://gree-ac.tail6be2e.ts.net` |
| package | `tailscale`, armhf, from the `raspbian trixie` apt repo |
| measured cost | 28.3 MB RSS, 0.10% of one core at idle |

## Setup

Installed by hand once. `setup-pi.sh` does not do this, because joining a
tailnet needs an interactive login.

```bash
# ON THE PI
curl -fsSL https://pkgs.tailscale.com/stable/raspbian/trixie.noarmor.gpg \
  | sudo tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null
curl -fsSL https://pkgs.tailscale.com/stable/raspbian/trixie.tailscale-keyring.list \
  | sudo tee /etc/apt/sources.list.d/tailscale.list >/dev/null
sudo apt-get update && sudo apt-get install -y tailscale

sudo tailscale up --hostname=gree-ac --accept-dns=false
sudo tailscale serve --bg 8481
```

Three things then have to be enabled in the admin console. `serve` prints a
one-click link for the first when it needs it, and MagicDNS is already on for
any tailnet created since October 2022:

1. **Serve**, from the link `tailscale serve` prints.
2. **HTTPS Certificates**, on the [DNS page](https://login.tailscale.com/admin/dns),
   below the nameserver settings. Requires MagicDNS. `serve` provisions the
   certificate itself, so there is no need to run `tailscale cert`.
3. **Disable key expiry** on the `gree-ac` node, from the **⋯** menu on the
   [Machines page](https://login.tailscale.com/admin/machines).

Step 3 is the one that actually matters. Node keys expire after 180 days by
default. The box would drop off the tailnet on its own, while you are a
thousand kilometres away, with no way back in. Nothing else on this page can
save you from that. Confirm it stuck:

```bash
ssh gree-ac 'tailscale status --json' | grep -c KeyExpiry   # 0 means disabled
```

Enabling HTTPS publishes the machine name and the tailnet DNS name to public
certificate transparency logs. That discloses the name, not access to it, and
it is inherent to Let's Encrypt rather than anything Tailscale chose.

## Why these flags

**`--accept-dns=false`.** Accepting tailnet DNS lets `tailscaled` rewrite
`resolv.conf`. The Pi resolves the AC by IP and needs nothing from MagicDNS, so
there is no upside, and a DNS regression on an unattended box is expensive.
Your phone still gets MagicDNS; this only opts the Pi out.

**No subnet router, no exit node, no IP forwarding.** The phone only ever needs
to reach the Pi, and the Pi already reaches the AC over the LAN. Advertising
routes would add moving parts for nothing.

**`serve`, not `funnel`.** `serve` publishes to your tailnet only. `funnel`
would publish to the public internet, which is exactly what this project
refuses to do.

## One origin, everywhere

Use `https://gree-ac.tail6be2e.ts.net` at home too, not just when away.

The PWA keys everything to its origin: the service worker, the shell cache, the
saved bridge token, the theme. Install it from a LAN address and again from the
tailnet name, and you get two half-configured apps. Pick the tailnet name, add
that one to the Home Screen, and delete any older icon.

It also lifts a limitation the PWA has carried from the start (see "Offline and
caching" in [../pwa/README.md](../pwa/README.md)). Browsers only expose
`serviceWorker` in a secure context, so over plain `http://gree-ac.local:8481`
the worker in `pwa/public/sw.js` never registered and the shell cache never
existed. Measured before the switch:

```
origin http://192.168.1.73:8481   secureContext false   serviceWorkerAPI false
```

Over HTTPS it registers, so the app shell now boots from cache and can render
its own "cannot reach the bridge" state instead of a browser error page.

## The API token

`API_TOKEN` lives in a systemd drop-in on the Pi, not in the unit file:

```
/etc/systemd/system/greehvacd.service.d/10-token.conf   # 0600, root
```

`deploy-pi.command` reinstalls `greehvacd.service` on every ship, and that file
is tracked in git. A token in it would be both overwritten and committed.
Drop-ins survive deploys and stay out of the repo, and `deploy-pi.command`
reads the token back over ssh so its post-deploy health check still passes.

Paste the same value into the PWA's Settings screen on each phone. Rotate by
editing the drop-in and running `sudo systemctl restart greehvacd`.

## Verify

Do this from cellular with Wi-Fi **off**. Testing on the home Wi-Fi passes for
the wrong reason and proves nothing.

```bash
U=https://gree-ac.tail6be2e.ts.net
TOK=$(ssh gree-ac "sudo sed -n 's/^Environment=API_TOKEN=//p' \
  /etc/systemd/system/greehvacd.service.d/10-token.conf")

curl -so /dev/null -w '%{http_code}\n' $U/api/state                    # 401
curl -sS -H "Authorization: Bearer $TOK" $U/api/health                 # {"status":"ok",...}
```

`/api/health` is behind the token like every other `/api` route, so a bare
`401` there is the daemon working, not a fault.

From the Pi itself the name will not resolve, because it runs with
`--accept-dns=false`. Pin the address rather than turning that off:

```bash
# ON THE PI
NAME=$(tailscale status --json | sed -n 's/.*"DNSName": "\([^"]*\)\.",*/\1/p' | head -1)
curl -sS --resolve "$NAME:443:$(tailscale ip -4)" \
  "https://$NAME/api/health" -H "Authorization: Bearer <token>"
```

Both values are read back from `tailscale` rather than written down here. The
tailnet name is in Certificate Transparency logs anyway, but the node's `100.x`
address is not, and this file is public.

Then open the app, confirm live state, and change something. Measured on this
setup: HTTP/2, a Let's Encrypt certificate for the tailnet name, and the first
SSE event 1.15 s after connect, so nothing is buffering the stream. The service
worker registers and precaches 18 entries, with zero `/api/` responses among
them, which is the property `sw.js` depends on to never show a stale reading.

## What was rejected

**Port-forwarding 8481.** Puts an unauthenticated control plane for a heating
appliance on the public internet. Never do this.

**Cloudflare Tunnel.** Another daemon, a domain, and an account, to land in the
same place. Cloudflare terminates TLS, so it sees the plaintext.

**WireGuard on the FRITZ!Box.** A real alternative, and the fallback if you ever
want the control plane out of the path. The connection supports it: the router
has a public IPv4 (WAN address and internet-observed address match, so no
CGNAT) and runs FRITZ!OS 8.25. It costs a MyFRITZ dynamic DNS name, one open UDP
port, a config per phone, and it still leaves the app on plain HTTP.

## If it breaks

| symptom | check |
|---------|-------|
| app unreachable from outside, fine at home | `tailscale status` on the Pi; node key may have expired |
| unreachable everywhere | the Pi is off the Wi-Fi; see the watchdog in [pi-runbook.md](pi-runbook.md) |
| certificate error | MagicDNS or HTTPS Certificates got disabled in the admin console |
| 401 from the app | token missing in Settings on that phone, or rotated on the Pi |
| live updates stall, buttons still work | SSE is being buffered; `tailscale serve status` |
