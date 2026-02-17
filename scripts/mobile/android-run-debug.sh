#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_ID="ai.q9labs.chalk.nativeapp"

if ! command -v adb >/dev/null; then
  echo "Missing adb. Install Android platform-tools."
  exit 1
fi

SERIAL="${ANDROID_SERIAL:-}"
if [[ -z "$SERIAL" ]]; then
  SERIAL="$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit 0}')"
fi

if [[ -z "$SERIAL" ]]; then
  echo "No Android device/emulator found. Start one, then retry."
  echo "Tip: Android Studio -> Device Manager -> Start"
  exit 1
fi

bash "$ROOT_DIR/scripts/mobile/android-install-debug.sh"

# Launch app (doesn't require knowing the Activity class).
adb -s "$SERIAL" shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "Launched: $APP_ID ($SERIAL)"

