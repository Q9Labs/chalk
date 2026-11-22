#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! "${1%/}" =~ ^https://3070-[a-z0-9]+\.instabox\.tech$ ]]; then
  echo "Usage: bash apps/mobile/scripts/build-orb-apk.sh <HTTPS web origin from orb up>" >&2
  exit 2
fi
export CHALK_APP_VARIANT=orb CHALK_MOBILE_ORB_URL="${1%/}"
unset EAS_BUILD_PROFILE
cd "$(dirname "$0")/../../.."

key=apps/mobile/android/app/debug.keystore
if [[ ! -f "$key" ]]; then
  keytool -genkeypair -keystore "$key" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10000 -dname 'CN=Android Debug,O=Android,C=US'
fi

pnpm install --frozen-lockfile
pnpm --dir apps/mobile run prepare:native-dependencies
# Gradle does not track rebuilt workspace SDK chunks or a changed Orb URL as bundle inputs.
pnpm --dir apps/mobile exec node scripts/gradle.mjs :app:createBundleReleaseJsAndAssets --rerun :app:assembleRelease -PreactNativeArchitectures=arm64-v8a

mkdir -p .verify/android-annotation-phone
apk=.verify/android-annotation-phone/chalk-orb.apk
cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk "$apk"
echo "Install: adb install -r \"$PWD/$apk\""
