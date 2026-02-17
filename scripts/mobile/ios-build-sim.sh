#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="$ROOT_DIR/apps/ios/ChalkNativeApp/ChalkNativeApp.xcodeproj"
SCHEME="ChalkNativeApp"
DERIVED_DATA="$ROOT_DIR/.build/deriveddata/ChalkNativeApp"

# RealtimeKit xcframework currently missing x86_64 simulator slice.
# Force arm64-only simulator build to avoid universal (x86_64+arm64) link failure.
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO ONLY_ACTIVE_ARCH=YES ARCHS=arm64 \
  build

