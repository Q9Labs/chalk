#!/usr/bin/env bash
# Streams the app's logcat lines from ADB_SERIAL, or from the first attached device.
set -euo pipefail
serial="${ADB_SERIAL:-$(adb devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}"
if [[ -z "${serial}" ]]; then
  echo "No connected adb device found. Set ADB_SERIAL to a connected device." >&2
  exit 1
fi
adb -s "${serial}" logcat | rg "ReactNativeJS|chalk|Expo"
