#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PKG="ai.q9labs.chalk.nativeapp"
ACTIVITY="${PKG}/.MainActivity"
APK="$ROOT/apps/android/app/build/outputs/apk/debug/app-debug.apk"

if ! command -v adb >/dev/null 2>&1; then
  echo "[android] adb not found (install Android platform-tools)" >&2
  exit 1
fi

if [ -n "${ANDROID_SERIAL:-}" ]; then
  echo "[android] device: $ANDROID_SERIAL"
else
  DEVICE_COUNT="$(adb devices | awk 'NR>1 && $2=="device"{c++} END{print c+0}')"
  if [ "$DEVICE_COUNT" -eq 0 ]; then
    echo "[android] no connected devices. start an emulator or plug a device." >&2
    echo "[android] tip: set ANDROID_SERIAL to pick one." >&2
    adb devices >&2 || true
    exit 1
  fi
  if [ "$DEVICE_COUNT" -gt 1 ]; then
    echo "[android] multiple devices. set ANDROID_SERIAL to pick one." >&2
    adb devices >&2 || true
    exit 1
  fi
  echo "[android] device: $(adb devices | awk 'NR>1 && $2==\"device\"{print $1; exit}')"
fi

echo "[android] build..."
(cd "$ROOT/apps/android" && ./gradlew :app:assembleDebug)

if [ ! -f "$APK" ]; then
  echo "[android] missing apk: $APK" >&2
  exit 1
fi

echo "[android] stop..."
adb shell am force-stop "$PKG" >/dev/null 2>&1 || true

echo "[android] wipe app data..."
adb uninstall "$PKG" >/dev/null 2>&1 || true

echo "[android] install..."
adb install -r "$APK" >/dev/null

echo "[android] launch..."
adb shell am start -n "$ACTIVITY" >/dev/null

echo "[android] logcat clear (optional)..."
adb logcat -c >/dev/null 2>&1 || true

echo "[android] done"

