#!/usr/bin/env bash
set -euo pipefail

# Rebuild + uninstall + reinstall + relaunch Chalk iOS Simulator app (clears app data/cache).
#
# Usage:
#   scripts/ios-sim-relaunch-clean.sh
#   DEVICE_ID=<udid> scripts/ios-sim-relaunch-clean.sh
#   BUNDLE_ID=ai.q9labs.chalk.nativeapp scripts/ios-sim-relaunch-clean.sh
#
# Notes:
# - Uses a fresh DerivedData folder each run.
# - Uninstall wipes the app container, which is the "no cache" part.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="$ROOT/apps/ios/ChalkNativeApp/ChalkNativeApp.xcodeproj"
SCHEME="${SCHEME:-ChalkNativeApp}"
BUNDLE_ID="${BUNDLE_ID:-ai.q9labs.chalk.nativeapp}"
CONFIGURATION="${CONFIGURATION:-Debug}"
DERIVED_DATA="${DERIVED_DATA:-/tmp/chalk-ios-derived-clean}"

pick_booted_device() {
  xcrun simctl list devices booted | awk -F '[()]' '/Booted/ {print $2; exit}'
}

DEVICE_ID="${DEVICE_ID:-$(pick_booted_device)}"
if [[ -z "${DEVICE_ID}" ]]; then
  echo "No booted iOS Simulator device found. Boot one, or set DEVICE_ID=<udid>." >&2
  exit 1
fi

echo "[ios] device: $DEVICE_ID"
echo "[ios] bundle: $BUNDLE_ID"

open -a Simulator || true
osascript -e 'tell application "Simulator" to activate' || true
xcrun simctl bootstatus "$DEVICE_ID" -b

rm -rf "$DERIVED_DATA"

echo "[ios] build..."
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration "$CONFIGURATION" \
  -destination "platform=iOS Simulator,id=$DEVICE_ID" \
  -derivedDataPath "$DERIVED_DATA" \
  build

APP="$DERIVED_DATA/Build/Products/${CONFIGURATION}-iphonesimulator/ChalkNativeApp.app"
if [[ ! -d "$APP" ]]; then
  echo "Built app not found at: $APP" >&2
  exit 1
fi

echo "[ios] reinstall (wipe data)..."
xcrun simctl terminate "$DEVICE_ID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl uninstall "$DEVICE_ID" "$BUNDLE_ID" 2>/dev/null || true
xcrun simctl install "$DEVICE_ID" "$APP"

echo "[ios] launch..."
xcrun simctl launch "$DEVICE_ID" "$BUNDLE_ID"

