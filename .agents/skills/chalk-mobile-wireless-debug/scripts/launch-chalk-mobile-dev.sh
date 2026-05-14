#!/usr/bin/env bash
set -euo pipefail

package_name="${1:-${CHALK_MOBILE_PACKAGE:-}}"
serial="${ADB_SERIAL:-}"

if ! command -v adb >/dev/null 2>&1; then
  echo "adb is required. Install Android platform-tools first." >&2
  exit 1
fi

if [[ -z "$package_name" ]]; then
  echo "Pass a package name or set CHALK_MOBILE_PACKAGE." >&2
  exit 1
fi

if [[ -z "$serial" ]]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" {print $1; exit}')"
fi

if [[ -z "$serial" ]]; then
  echo "No connected adb device found. Set ADB_SERIAL or run pnpm run mobile:connect first." >&2
  exit 1
fi

adb -s "$serial" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1
