#!/usr/bin/env bash
#
# setup-pi.sh — one-time tuning for the Raspberry Pi Zero W running greehvacd.
#
# Run once on the Pi after first boot:
#   scp gree-hvac-rs/deploy/setup-pi.sh p0mman@gree-ac.local:
#   ssh p0mman@gree-ac.local 'bash setup-pi.sh'
#
# Everything here is either a correctness fix for the GREE UDP protocol on this
# hardware, or an SD-card longevity measure. None of it is cosmetic.
#
set -euo pipefail

# Re-exec under sudo when not already root. $0 must be resolved to an absolute
# path first: invoked as `bash setup-pi.sh` it is a bare relative name, and sudo
# does not search the working directory, so it fails with "command not found".
if [ "$(id -u)" -ne 0 ]; then
  SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
  exec sudo -- bash "$SELF" "$@"
fi

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

# --- sanity: are we actually on ARMv6? ---------------------------------
bold "==> Hardware"
uname -m        # expect: armv6l
grep -m1 "^Model" /proc/cpuinfo || true
if [ "$(uname -m)" != "armv6l" ]; then
  echo "WARNING: expected armv6l. If this says armv7l/aarch64 you are not on a Zero W," >&2
  echo "         and the ARMv6 binary will still run, just suboptimally." >&2
fi

# --- Wi-Fi power save --------------------------------------------------
# This is the one that actually matters. The Zero W's BCM43438 parks the radio
# between beacons when power save is on, which adds tens to hundreds of ms of
# latency and silently drops inbound UDP. GREE's protocol is unacknowledged UDP
# on a 3 s poll, so the symptom is the app randomly showing "offline" and
# remote-control changes taking seconds to appear. Turn it off.
bold "==> Disabling Wi-Fi power save"
# `iw` is not in the Lite image, and without it there is no way to read the
# radio's actual state — only what NetworkManager intends. Worth 150 KB.
dpkg -s iw >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y -qq iw; }
install -d /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/wifi-powersave-off.conf <<'EOF'
# 2 = disable power save. The GREE bridge polls over unacknowledged UDP;
# a parked radio drops those packets and the AC reads as offline.
[connection]
wifi.powersave = 2
EOF

# --- locale ------------------------------------------------------------
# macOS forwards LC_CTYPE=UTF-8, which is no valid glibc locale name, so logins
# print setlocale warnings.
#
# DO NOT "fix" this by touching sshd. An earlier version of this script dropped
# an `AcceptEnv` override into /etc/ssh/sshd_config.d/ and ran
# `systemctl restart ssh`. On Debian 13 port 22 belongs to ssh.socket, and
# ssh.service conflicts with it — the restart stopped the socket and the box
# came back from reboot with nothing listening on 22. Locked out, rescued only
# via the boot partition. The warnings are cosmetic; a lockout is not.
#
# Set a valid system default and leave the ssh daemon alone. Anything the client
# forwards still wins for that session, so warnings may persist — that is fine.
bold "==> Setting a valid default locale (not touching sshd)"
if ! locale -a 2>/dev/null | grep -qi '^C\.utf-\?8$'; then
  apt-get update -qq
  apt-get install -y -qq locales
fi
update-locale LANG=C.UTF-8

# --- journal size ------------------------------------------------------
# The daemon logs a line per state change, forever, onto an SD card. Cap it.
bold "==> Capping the journal at 32M"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/00-size-cap.conf <<'EOF'
[Journal]
SystemMaxUse=32M
SystemMaxFileSize=8M
EOF

# --- filesystem writes -------------------------------------------------
# noatime cuts a write per file read. The PWA bundle is read on every page
# load, so this is a real reduction in card wear, not a micro-optimisation.
bold "==> Enabling noatime on the root filesystem"
if ! grep -qE '^\s*[^#].*\s/\s.*noatime' /etc/fstab; then
  sed -i -E 's|^(\S+\s+/\s+\S+\s+)([^ \t]+)|\1noatime,\2|' /etc/fstab
  echo "    added (takes effect on reboot)"
else
  echo "    already set"
fi

# --- mDNS --------------------------------------------------------------
# So http://gree-ac.local:8481 resolves from your Mac and phone without
# knowing the IP. Lite images ship avahi but do not always enable it.
bold "==> Ensuring avahi (gree-ac.local) is running"
if ! dpkg -s avahi-daemon >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq avahi-daemon
fi
systemctl enable --now avahi-daemon

# --- trim the idle footprint ------------------------------------------
# 512 MB and one 1 GHz core. Nothing here is used by a headless bridge.
bold "==> Disabling services this box does not need"
for svc in bluetooth hciuart triggerhappy; do
  if systemctl list-unit-files | grep -q "^$svc.service"; then
    systemctl disable --now "$svc" 2>/dev/null || true
    echo "    disabled $svc"
  fi
done

# --- unattended security updates --------------------------------------
# This box sits on your LAN for years. Security patches should not depend on
# you remembering.
bold "==> Enabling unattended security upgrades"
apt-get install -y -qq unattended-upgrades
systemctl enable --now unattended-upgrades

bold "==> Done. Reboot to apply noatime and the Wi-Fi power-save change:"
echo "    sudo reboot"
echo
echo "After reboot, verify power save is off. Use the absolute path: /usr/sbin is"
echo "not on the PATH for non-interactive ssh commands."
echo "    ssh gree-ac '/usr/sbin/iw wlan0 get power_save'   # expect: Power save: off"
