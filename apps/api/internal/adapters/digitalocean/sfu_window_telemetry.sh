#!/bin/bash
# Runs once from cloud-init on a window node's first boot. The window snapshot carries no ingest token, so the
# controller sends the Axiom headers in the Droplet's user data and this script turns them into what a standing
# node gets from deploy: Podman secrets, the unit's Secret lines and the OTLP endpoint. It then runs the boot
# unit again, which renders the templates and restarts the node with export on.
set -euo pipefail
dir=/run/chalk-window-telemetry
trap 'rm -rf "$dir"' EXIT
uid=$(id -u chalk-sfu)
systemctl start "user@${uid}.service"
as_sfu() {
  runuser -u chalk-sfu -- env -i HOME=/home/chalk-sfu PATH=/usr/bin:/bin \
    XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" "$@"
}
unit=/etc/chalk-sfu/chalk-sfu.container.template
for pair in metrics:chalk-sfu-otlp-headers:OTEL_EXPORTER_OTLP_METRICS_HEADERS:Metrics log:chalk-sfu-otlp-log-headers:OTEL_EXPORTER_OTLP_LOGS_HEADERS:Log; do
  IFS=: read -r file secret variable label <<<"$pair"
  [[ -s "$dir/$file-headers" ]] || continue
  as_sfu podman secret rm "$secret" >/dev/null 2>&1 || true
  as_sfu podman secret create "$secret" - <"$dir/$file-headers" >/dev/null
  sed -i "s|^# $label export is off:.*\$|Secret=$secret,type=env,target=$variable|" "$unit"
done
sed -i "s|^SFU_OTLP_ENDPOINT=.*\$|SFU_OTLP_ENDPOINT=$(cat "$dir/endpoint")|" /etc/chalk-sfu/sfu.env.template
systemctl restart chalk-sfu-window.service
