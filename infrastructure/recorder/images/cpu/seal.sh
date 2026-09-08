#!/usr/bin/env bash
set -euo pipefail

[[ "$(id -u)" == "0" ]] || { echo "seal must run as root" >&2; exit 1; }
[[ -f /opt/chalk-recorder/image-manifest.json && -f /etc/chalk-recorder/image.env ]] || { echo "recorder CPU image is not installed" >&2; exit 1; }
systemctl is-active --quiet chalk-recorder-capture.service && { echo "capture worker is active" >&2; exit 1; }
systemctl is-active --quiet chalk-recorder-render.service && { echo "render worker is active" >&2; exit 1; }

systemctl disable chalk-recorder-capture.service chalk-recorder-render.service chalk-recorder-renew.timer >/dev/null 2>&1 || true
rm -f -- /etc/chalk-recorder/bootstrap.env /etc/chalk-recorder/node.env /etc/chalk-recorder/worker.env
rm -f -- /usr/local/bin/go /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm
rm -rf -- /opt/chalk-recorder/toolchains/go-1.25.13 /opt/chalk-recorder/toolchains/corepack
find /etc/chalk-recorder/identity -mindepth 1 -maxdepth 1 -type f -delete
find /root/.ssh /home -type f -name authorized_keys -delete 2>/dev/null || true
find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*' -delete
rm -f -- /root/.bash_history /root/.zsh_history
find /home -maxdepth 2 -type f \( -name .bash_history -o -name .zsh_history \) -delete

cloud-init clean --logs --seed
truncate -s 0 /etc/machine-id
rm -f -- /var/lib/dbus/machine-id
journalctl --rotate
journalctl --vacuum-time=1s >/dev/null
apt-get clean
rm -rf -- /var/lib/apt/lists/* /tmp/* /var/tmp/*

if find /root/.ssh /home -type f -name authorized_keys -print -quit 2>/dev/null | grep -q .; then
  echo "authorized_keys remains after seal" >&2
  exit 1
fi
if find /etc/ssh -maxdepth 1 -type f -name 'ssh_host_*' -print -quit | grep -q .; then
  echo "SSH host key remains after seal" >&2
  exit 1
fi
for forbidden in /etc/chalk-recorder/bootstrap.env /etc/chalk-recorder/node.env /etc/chalk-recorder/worker.env; do
  [[ ! -e "$forbidden" ]] || { echo "runtime identity input remains: $forbidden" >&2; exit 1; }
done
[[ -z "$(find /etc/chalk-recorder/identity -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo "runtime identity remains after seal" >&2; exit 1; }

echo "recorder CPU image sealed; shut down before creating the DigitalOcean snapshot"
