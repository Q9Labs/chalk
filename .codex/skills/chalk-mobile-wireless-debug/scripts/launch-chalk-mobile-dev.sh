#!/usr/bin/env bash
set -euo pipefail

package_name="${CHALK_MOBILE_PACKAGE:-ai.q9labs.chalk.mobile}"
port="${CHALK_MOBILE_METRO_PORT:-8081}"
serial="${ADB_SERIAL:-}"

if [[ -z "$serial" ]]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" {print $1; exit}')"
fi

if [[ -z "$serial" ]]; then
  echo "No connected adb device found. Set ADB_SERIAL or connect a phone first." >&2
  exit 1
fi

host_ip="${CHALK_MOBILE_HOST_IP:-}"
if [[ -z "$host_ip" ]]; then
  default_iface="$(route get default 2>/dev/null | awk '/interface: / {print $2; exit}')"
  if [[ -n "$default_iface" ]]; then
    host_ip="$(ipconfig getifaddr "$default_iface" 2>/dev/null || true)"
  fi
fi

if [[ -z "$host_ip" ]]; then
  echo "Could not determine Mac LAN IP. Set CHALK_MOBILE_HOST_IP." >&2
  exit 1
fi

deep_link="exp+chalk-mobile://expo-development-client/?url=http%3A%2F%2F${host_ip}%3A${port}"

adb -s "$serial" shell am force-stop "$package_name" >/dev/null 2>&1 || true
adb -s "$serial" shell am start -a android.intent.action.VIEW -d "$deep_link" "$package_name"
echo "serial=$serial"
echo "metro=http://${host_ip}:${port}"
