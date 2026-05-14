#!/usr/bin/env bash
set -euo pipefail

target="${1:-${ADB_DEVICE_IP:-}}"
port="${ADB_TCP_PORT:-5555}"
serial="${ADB_SERIAL:-}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb is required. Install Android platform-tools first." >&2
  exit 1
fi

if [[ -z "$serial" ]]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" && $1 !~ /:/ {print $1; exit}')"
fi

if [[ -n "$target" ]]; then
  if [[ "$target" != *:* ]]; then
    target="${target}:${port}"
  fi
  adb connect "$target"
  exit 0
fi

if [[ -z "$serial" ]]; then
  echo "Connect a device over USB first, pass <ip:port>, or set ADB_DEVICE_IP." >&2
  exit 1
fi

adb -s "$serial" tcpip "$port"
cat <<EOF
Wireless ADB enabled on port ${port}.
Now set ADB_DEVICE_IP or run:
  bash .agents/skills/chalk-mobile-wireless-debug/scripts/connect-wireless-adb.sh <device-ip>:${port}
EOF
