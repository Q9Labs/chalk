#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/ChalkNativeApp/ChalkNativeApp.xcodeproj"
SCHEME="ChalkNativeApp"
DERIVED_DATA="$ROOT_DIR/.build/deriveddata/ChalkNativeApp"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/ChalkNativeApp.app"
BUNDLE_ID="ai.q9labs.chalk.nativeapp"

booted_udid() {
  xcrun simctl list devices booted -j \
    | /usr/bin/python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
devices = data.get("devices", {})
for _rt, devs in devices.items():
  for d in devs:
    if d.get("state") == "Booted" and d.get("isAvailable", True):
      print(d.get("udid", ""))
      sys.exit(0)
sys.exit(1)
PY
}

first_available_iphone_udid() {
  xcrun simctl list devices available -j \
    | /usr/bin/python3 - <<'PY'
import json, sys
data = json.load(sys.stdin)
devices = data.get("devices", {})
for _rt, devs in devices.items():
  for d in devs:
    name = d.get("name", "")
    if d.get("isAvailable", True) and "iPhone" in name:
      print(d.get("udid", ""))
      sys.exit(0)
sys.exit(1)
PY
}

UDID=""
if UDID="$(booted_udid)"; then
  :
else
  UDID="$(first_available_iphone_udid)"
  echo "No booted simulator. Booting: $UDID"
  xcrun simctl boot "$UDID" >/dev/null
  xcrun simctl bootstatus "$UDID" -b >/dev/null
fi

bash "$ROOT_DIR/scripts/mobile/ios-build-sim.sh"

if [[ ! -d "$APP_PATH" ]]; then
  echo "Missing app bundle: $APP_PATH"
  exit 1
fi

xcrun simctl install "$UDID" "$APP_PATH" >/dev/null
xcrun simctl launch "$UDID" "$BUNDLE_ID"

