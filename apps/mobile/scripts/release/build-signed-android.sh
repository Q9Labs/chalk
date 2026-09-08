#!/usr/bin/env bash

set -euo pipefail

mobile_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
repo_root=$(cd "$mobile_root/../.." && pwd)
manifest="$repo_root/release/manifest.json"
output_dir=${SIGNED_OUTPUT_DIR:-"$mobile_root/build/releases"}
mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
temp_parent=${RUNNER_TEMP:-/private/tmp}
temp_dir=$(mktemp -d "$temp_parent/chalk-android-signing.XXXXXX")
gradle_build_dir=""

cleanup() {
  unset CHALK_ANDROID_KEYSTORE_PROPERTIES
  unset CHALK_APP_VARIANT
  unset GRADLE_USER_HOME

  if [[ -n "$gradle_build_dir" && -d "$gradle_build_dir" && ! -L "$gradle_build_dir" && $(dirname "$gradle_build_dir") == "$output_dir" && $(basename "$gradle_build_dir") == .chalk-gradle-build.* ]]; then
    find "$gradle_build_dir" -depth -delete
  fi
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
op read --force --out-file "$temp_dir/store.password" "$signing_ref/password" >/dev/null
op read --force --out-file "$temp_dir/key.password" "$signing_ref/key_password" >/dev/null
op read --force --out-file "$temp_dir/key.alias" "$signing_ref/key_alias" >/dev/null
chmod 600 "$temp_dir"/*

gradle_user_home="$temp_dir/gradle-user-home"
mkdir -p "$gradle_user_home"
chmod 700 "$gradle_user_home"
gradle_properties="$gradle_user_home/keystore.properties"
{
  printf 'storeFile=%s\n' "$temp_dir/upload.jks"
  printf 'storePassword='
  cat "$temp_dir/store.password"
  printf '\n'
  printf 'keyAlias='
  cat "$temp_dir/key.alias"
  printf '\n'
  printf 'keyPassword='
  cat "$temp_dir/key.password"
  printf '\n'
} > "$gradle_properties"
chmod 600 "$gradle_properties"
export CHALK_ANDROID_KEYSTORE_PROPERTIES="$gradle_properties"
export GRADLE_USER_HOME="$gradle_user_home"
export CHALK_APP_VARIANT=production

expected_keystore_sha256=$(jq -er '.android.keystore_sha256' "$manifest")
expected_certificate_sha256=$(jq -er '.android.certificate_sha256' "$manifest")
actual_keystore_sha256=$(shasum -a 256 "$temp_dir/upload.jks" | sed 's/ .*//')

normalize_fingerprint() {
  printf '%s' "$1" | tr -d ':' | tr '[:lower:]' '[:upper:]'
}

if [[ "$actual_keystore_sha256" != "$expected_keystore_sha256" || \
  "$(normalize_fingerprint "$actual_certificate_sha256")" != "$(normalize_fingerprint "$expected_certificate_sha256")" ]]; then
  echo "The recovered Chalk Android signing identity does not match the release manifest." >&2
  exit 1
fi

echo "Running Chalk Android tests and signed release build."
gradle_build_dir=$(mktemp -d "$output_dir/.chalk-gradle-build.XXXXXX")
chmod 700 "$gradle_build_dir"
(
  cd "$repo_root"
  pnpm --filter @q9labsai/chalk-mobile run prepare:native-dependencies
  cd "$mobile_root/android"
  ./gradlew --no-daemon \
    -Pchalk.androidBuildDirectory="$gradle_build_dir" \
    testDebugUnitTest bundleRelease
)

built_bundle="$gradle_build_dir/outputs/bundle/release/app-release.aab"
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
output_bundle="$output_dir/chalk-android-$version_name-$version_code-$timestamp.aab"
cp "$built_bundle" "$output_bundle"

printf 'android_bundle=%s\n' "$output_bundle"
printf 'keystore_sha256=%s\n' "$actual_keystore_sha256"
printf 'certificate_sha256=%s\n' "$bundle_certificate_sha256"
