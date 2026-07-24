#!/bin/bash
#
# rescue-ssh.sh — runs once at boot, from the FAT32 boot partition, as root.
#
# Undoes the sshd change that left nothing listening on port 22, then removes
# itself. Logs to the boot partition so the result is readable from macOS even
# if SSH still does not come back.
#
# Installed by copying to /Volumes/bootfs/ and appending to cmdline.txt:
#   systemd.run=/boot/firmware/rescue-ssh.sh systemd.run_success_action=reboot systemd.unit=kernel-command-line.target
#
# Never exit non-zero: systemd.run_success_action=reboot only fires on success,
# and a failure here would leave the Pi sitting in the rescue target.
set +e

LOG=/boot/firmware/rescue-ssh.log
exec >"$LOG" 2>&1

echo "=== rescue-ssh.sh: $(date -u 2>/dev/null) ==="

mount -o remount,rw / 2>/dev/null
mount -o remount,rw /boot/firmware 2>/dev/null

echo "--- removing the offending drop-in ---"
rm -fv /etc/ssh/sshd_config.d/10-no-locale-env.conf

echo "--- validating sshd config ---"
/usr/sbin/sshd -t && echo "sshd config OK" || echo "sshd config STILL INVALID"

echo "--- current ssh unit state ---"
systemctl list-unit-files 'ssh*' --no-pager
systemctl is-enabled ssh.socket 2>&1
systemctl is-enabled ssh.service 2>&1

echo "--- restoring whichever unit this release expects ---"
systemctl unmask ssh.socket ssh.service 2>&1
if systemctl list-unit-files --no-pager | grep -q '^ssh\.socket'; then
  # Debian 13 default: the socket owns port 22 and spawns ssh@.service per
  # connection. The two units conflict, so exactly one may be enabled.
  echo "socket activation available -> enabling ssh.socket"
  systemctl disable ssh.service 2>&1
  systemctl enable ssh.socket 2>&1
else
  echo "no ssh.socket -> enabling ssh.service"
  systemctl enable ssh.service 2>&1
fi

echo "--- reverting cmdline.txt so this does not run again ---"
sed -i 's| systemd\.run=/boot/firmware/rescue-ssh\.sh systemd\.run_success_action=reboot systemd\.unit=kernel-command-line\.target||' \
  /boot/firmware/cmdline.txt
cat /boot/firmware/cmdline.txt

echo "--- removing self ---"
rm -f /boot/firmware/rescue-ssh.sh

echo "=== done, rebooting ==="
sync
exit 0
