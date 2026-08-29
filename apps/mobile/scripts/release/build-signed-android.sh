#!/usr/bin/env bash

set -euo pipefail

mobile_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
repo_root=$(cd "$mobile_root/../.." && pwd)
manifest="$repo_root/release/manifest.json"
output_dir=${SIGNED_OUTPUT_DIR:-"$mobile_root/build/releases"}
temp_parent=${RUNNER_TEMP:-/private/tmp}
temp_dir=$(mktemp -d "$temp_parent/chalk-android-signing.XXXXXX")

cleanup() {
  unset CHALK_ANDROID_KEYSTORE_PROPERTIES
  unset CHALK_APP_VARIANT

  if [[ -d "$temp_dir" && ! -L "$temp_dir" && $(basename "$temp_dir") == chalk-android-signing.* ]]; then
    find "$temp_dir" -depth -delete
  fi
}

trap cleanup EXIT HUP INT TERM

command -v op >/dev/null
command -v jq >/dev/null
command -v keytool >/dev/null
command -v jarsigner >/dev/null

chmod 700 "$temp_dir"
vault=$(jq -er '.vault' "$manifest")
signing_item_id=$(jq -er '.android.signing_item_id' "$manifest")
signing_ref="op://$vault/$signing_item_id"

echo "Recovering Chalk Android release credentials from 1Password."
op read --force --out-file "$temp_dir/upload.jks" "$signing_ref/keystore" >/dev/null
chmod 600 "$temp_dir/upload.jks"

store_password=$(op read "$signing_ref/password")
key_password=$(op read "$signing_ref/key_password")
key_alias=$(op read "$signing_ref/key_alias")

printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=%s\nkeyPassword=%s\n' \
  "$temp_dir/upload.jks" "$store_password" "$key_alias" "$key_password" > "$temp_dir/keystore.properties"
chmod 600 "$temp_dir/keystore.properties"
export CHALK_ANDROID_KEYSTORE_PROPERTIES="$temp_dir/keystore.properties"
export CHALK_APP_VARIANT=production

expected_keystore_sha256=$(jq -er '.android.keystore_sha256' "$manifest")
expected_certificate_sha256=$(jq -er '.android.certificate_sha256' "$manifest")
actual_keystore_sha256=$(shasum -a 256 "$temp_dir/upload.jks" | sed 's/ .*//')

keytool -list -v \
  -keystore "$temp_dir/upload.jks" \
  -alias "$key_alias" \
  -storepass "$store_password" \
  > "$temp_dir/keytool.txt"
actual_certificate_sha256=$(sed -n 's/^[[:space:]]*SHA256: //p' "$temp_dir/keytool.txt" | head -n 1)

normalize_fingerprint() {
  printf '%s' "$1" | tr -d ':' | tr '[:lower:]' '[:upper:]'
}

if [[ "$actual_keystore_sha256" != "$expected_keystore_sha256" || \
  "$(normalize_fingerprint "$actual_certificate_sha256")" != "$(normalize_fingerprint "$expected_certificate_sha256")" ]]; then
  echo "The recovered Chalk Android signing identity does not match the release manifest." >&2
  exit 1
fi

echo "Running Chalk Android tests and signed release build."
(
  cd "$repo_root"
  pnpm --filter @q9labsai/chalk-mobile run prepare:native-dependencies
  cd "$mobile_root/android"
  ./gradlew --no-daemon testDebugUnitTest bundleRelease
)

built_bundle="$mobile_root/android/app/build/outputs/bundle/release/app-release.aab"
if [[ ! -f "$built_bundle" ]]; then
  echo "Gradle completed without producing the expected Chalk release bundle." >&2
  exit 1
fi

jarsigner -verify "$built_bundle" >/dev/null
bundle_certificate_sha256=$(keytool -printcert -jarfile "$built_bundle" 2>/dev/null | sed -n 's/^[[:space:]]*SHA256: //p' | head -n 1)
if [[ "$(normalize_fingerprint "$bundle_certificate_sha256")" != "$(normalize_fingerprint "$expected_certificate_sha256")" ]]; then
  echo "The Chalk Android bundle was signed with an unexpected certificate." >&2
  exit 1
fi

timestamp=${CHALK_RELEASE_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
version_name=$(jq -er '.android.version_name' "$manifest")
version_code=$(jq -er '.android.version_code' "$manifest")
mkdir -p "$output_dir"
output_bundle="$output_dir/chalk-android-$version_name-$version_code-$timestamp.aab"
cp "$built_bundle" "$output_bundle"

printf 'android_bundle=%s\n' "$output_bundle"
printf 'keystore_sha256=%s\n' "$actual_keystore_sha256"
printf 'certificate_sha256=%s\n' "$bundle_certificate_sha256"
