#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/apps/android"

if ! command -v adb >/dev/null; then
  echo "Missing adb. Install Android platform-tools."
  exit 1
fi

if [[ -z "${ANDROID_SERIAL:-}" ]]; then
  if ! adb devices | awk 'NR>1 && $2=="device" {found=1} END {exit found?0:1}'; then
    echo "No Android device/emulator found. Start one, then retry."
    echo "Tip: Android Studio -> Device Manager -> Start"
    exit 1
  fi
fi

./gradlew :app:installDebug
