#!/usr/bin/env bash

set -euo pipefail

mobile_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
repo_root=$(cd "$mobile_root/../.." && pwd)
manifest="$repo_root/release/manifest.json"
output_dir=${SIGNED_OUTPUT_DIR:-"$mobile_root/build/releases"}
temp_parent=${RUNNER_TEMP:-/private/tmp}
temp_dir=$(mktemp -d "$temp_parent/chalk-ios-signing.XXXXXX")
keychain_path="$temp_dir/chalk-release.keychain-db"
profile_dir="$HOME/Library/MobileDevice/Provisioning Profiles"
main_profile_path=""
screen_share_profile_path=""
main_profile_was_present=false
screen_share_profile_was_present=false
original_keychains=()

while IFS= read -r keychain; do
  keychain=${keychain#*\"}
  keychain=${keychain%\"*}
  [[ -n "$keychain" ]] && original_keychains+=("$keychain")
done < <(security list-keychains -d user 2>/dev/null || true)

cleanup() {
  if ((${#original_keychains[@]})); then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true

  if [[ "$main_profile_was_present" == false && -n "$main_profile_path" && -f "$main_profile_path" && ! -L "$main_profile_path" ]]; then
    find "$main_profile_path" -delete
  fi
  if [[ "$screen_share_profile_was_present" == false && -n "$screen_share_profile_path" && -f "$screen_share_profile_path" && ! -L "$screen_share_profile_path" ]]; then
    find "$screen_share_profile_path" -delete
  fi

  unset CHALK_APP_VARIANT
  if [[ -d "$temp_dir" && ! -L "$temp_dir" && $(basename "$temp_dir") == chalk-ios-signing.* ]]; then
    find "$temp_dir" -depth -delete
  fi
}

trap cleanup EXIT HUP INT TERM

for command_name in op jq security xcodebuild codesign openssl plutil unzip ditto; do
  command -v "$command_name" >/dev/null
done

chmod 700 "$temp_dir"
vault=$(jq -er '.vault' "$manifest")
p12_item_id=$(jq -er '.apple.p12_item_id' "$manifest")
p12_password_item_id=$(jq -er '.apple.p12_password_item_id' "$manifest")
main_profile_item_id=$(jq -er '.apple.profile_item_id' "$manifest")
screen_share_profile_item_id=$(jq -er '.apple.screen_share_profile_item_id' "$manifest")
expected_team_id=$(jq -er '.apple.team_id' "$manifest")
expected_bundle_id=$(jq -er '.apple.bundle_id' "$manifest")
expected_screen_share_bundle_id=$(jq -er '.apple.screen_share_bundle_id' "$manifest")
expected_profile_name=$(jq -er '.apple.profile_name' "$manifest")
expected_profile_uuid=$(jq -er '.apple.profile_uuid' "$manifest")
expected_screen_share_profile_name=$(jq -er '.apple.screen_share_profile_name' "$manifest")
expected_screen_share_profile_uuid=$(jq -er '.apple.screen_share_profile_uuid' "$manifest")
expected_profile_certificate_sha256=$(jq -er '.apple.profile_certificate_sha256' "$manifest")

echo "Recovering Chalk iOS release credentials from 1Password."
op document get --force "$p12_item_id" --vault "$vault" --out-file "$temp_dir/distribution.p12" >/dev/null
op document get --force "$p12_password_item_id" --vault "$vault" --out-file "$temp_dir/p12.pass" >/dev/null
op document get --force "$main_profile_item_id" --vault "$vault" --out-file "$temp_dir/main.mobileprovision" >/dev/null
op document get --force "$screen_share_profile_item_id" --vault "$vault" --out-file "$temp_dir/screen-share.mobileprovision" >/dev/null
chmod 600 "$temp_dir"/*

security cms -D -i "$temp_dir/main.mobileprovision" > "$temp_dir/main.plist"
security cms -D -i "$temp_dir/screen-share.mobileprovision" > "$temp_dir/screen-share.plist"
main_profile_name=$(plutil -extract Name raw -o - "$temp_dir/main.plist")
main_profile_uuid=$(plutil -extract UUID raw -o - "$temp_dir/main.plist")
main_profile_app_id=$(plutil -extract Entitlements.application-identifier raw -o - "$temp_dir/main.plist")
screen_share_profile_name=$(plutil -extract Name raw -o - "$temp_dir/screen-share.plist")
screen_share_profile_uuid=$(plutil -extract UUID raw -o - "$temp_dir/screen-share.plist")
screen_share_profile_app_id=$(plutil -extract Entitlements.application-identifier raw -o - "$temp_dir/screen-share.plist")

if [[ "$main_profile_name" != "$expected_profile_name" || \
  "$main_profile_uuid" != "$expected_profile_uuid" || \
  "$main_profile_app_id" != "$expected_team_id.$expected_bundle_id" || \
  "$screen_share_profile_name" != "$expected_screen_share_profile_name" || \
  "$screen_share_profile_uuid" != "$expected_screen_share_profile_uuid" || \
  "$screen_share_profile_app_id" != "$expected_team_id.$expected_screen_share_bundle_id" ]]; then
  echo "The recovered Chalk iOS profiles do not match the release manifest." >&2
  exit 1
fi

printf '%s' "$(plutil -extract DeveloperCertificates.0 raw -o - "$temp_dir/main.plist")" | base64 --decode > "$temp_dir/profile.cer"
profile_certificate_sha256=$(openssl x509 -inform der -in "$temp_dir/profile.cer" -noout -fingerprint -sha256 | sed 's/.*=//')
normalize_fingerprint() {
  printf '%s' "$1" | tr -d ':' | tr '[:lower:]' '[:upper:]'
}
if [[ "$(normalize_fingerprint "$profile_certificate_sha256")" != "$(normalize_fingerprint "$expected_profile_certificate_sha256")" ]]; then
  echo "The recovered Chalk iOS profile certificate does not match the release manifest." >&2
  exit 1
fi

p12_password=$(<"$temp_dir/p12.pass")
p12_certificate_sha256=$(openssl pkcs12 -legacy -in "$temp_dir/distribution.p12" -passin file:"$temp_dir/p12.pass" -clcerts -nokeys 2>/dev/null | openssl x509 -noout -fingerprint -sha256 | sed 's/.*=//')
if [[ "$(normalize_fingerprint "$p12_certificate_sha256")" != "$(normalize_fingerprint "$expected_profile_certificate_sha256")" ]]; then
  echo "The shared Apple Distribution p12 does not match the Chalk App Store profiles." >&2
  echo "A provider-side certificate/profile repair is required before signed iOS builds can run." >&2
  exit 1
fi

keychain_password=$(openssl rand -hex 24)
security create-keychain -p "$keychain_password" "$keychain_path" >/dev/null
security set-keychain-settings -lut 21600 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$temp_dir/distribution.p12" -k "$keychain_path" -P "$p12_password" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$keychain_path" >/dev/null
security list-keychains -d user -s "$keychain_path" "${original_keychains[@]}"

mkdir -p "$profile_dir"
main_profile_path="$profile_dir/$main_profile_uuid.mobileprovision"
screen_share_profile_path="$profile_dir/$screen_share_profile_uuid.mobileprovision"
if [[ -f "$main_profile_path" ]]; then main_profile_was_present=true; fi
if [[ -f "$screen_share_profile_path" ]]; then screen_share_profile_was_present=true; fi
cp "$temp_dir/main.mobileprovision" "$main_profile_path"
cp "$temp_dir/screen-share.mobileprovision" "$screen_share_profile_path"

export CHALK_APP_VARIANT=production
archive_path="$temp_dir/Chalk.xcarchive"
archive_log="$temp_dir/archive.log"
echo "Building Chalk's signed iOS archive."
if ! xcodebuild \
  -workspace "$mobile_root/ios/Chalk.xcworkspace" \
  -scheme Chalk \
  -configuration Release \
  -destination generic/platform=iOS \
  -archivePath "$archive_path" \
  archive > "$archive_log" 2>&1; then
  rg -n 'error:|ARCHIVE FAILED' "$archive_log" | tail -80 >&2 || true
  tail -120 "$archive_log" >&2
  exit 1
fi

cat > "$temp_dir/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>export</string>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>teamID</key>
  <string>$expected_team_id</string>
  <key>uploadSymbols</key>
  <false/>
  <key>provisioningProfiles</key>
  <dict>
    <key>$expected_bundle_id</key>
    <string>$main_profile_name</string>
    <key>$expected_screen_share_bundle_id</key>
    <string>$screen_share_profile_name</string>
  </dict>
</dict>
</plist>
PLIST

export_path="$temp_dir/export"
if ! xcodebuild -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist "$temp_dir/ExportOptions.plist" > "$temp_dir/export.log" 2>&1; then
  rg -n 'error:|EXPORT FAILED' "$temp_dir/export.log" | tail -80 >&2 || true
  tail -120 "$temp_dir/export.log" >&2
  exit 1
fi

built_ipa=$(find "$export_path" -maxdepth 1 -type f -name '*.ipa' -print -quit)
if [[ -z "$built_ipa" ]]; then
  echo "Xcode completed without producing a Chalk IPA." >&2
  exit 1
fi

mkdir -p "$temp_dir/ipa"
unzip -q "$built_ipa" -d "$temp_dir/ipa"
app_path=$(find "$temp_dir/ipa/Payload" -maxdepth 1 -type d -name '*.app' -print -quit)
if [[ -z "$app_path" ]]; then
  echo "The Chalk IPA does not contain an app bundle." >&2
  exit 1
fi
codesign --verify --deep --strict "$app_path"
security cms -D -i "$app_path/embedded.mobileprovision" > "$temp_dir/embedded-main.plist"
embedded_main_uuid=$(plutil -extract UUID raw -o - "$temp_dir/embedded-main.plist")
embedded_main_app_id=$(plutil -extract Entitlements.application-identifier raw -o - "$temp_dir/embedded-main.plist")
if [[ "$embedded_main_uuid" != "$expected_profile_uuid" || "$embedded_main_app_id" != "$expected_team_id.$expected_bundle_id" ]]; then
  echo "The Chalk IPA contains an unexpected main-app provisioning profile." >&2
  exit 1
fi

screen_share_app_path=$(find "$app_path/PlugIns" -maxdepth 1 -type d -name '*.appex' -print -quit)
if [[ -z "$screen_share_app_path" ]]; then
  echo "The Chalk IPA does not contain the screen-share extension." >&2
  exit 1
fi
security cms -D -i "$screen_share_app_path/embedded.mobileprovision" > "$temp_dir/embedded-screen-share.plist"
embedded_screen_share_uuid=$(plutil -extract UUID raw -o - "$temp_dir/embedded-screen-share.plist")
embedded_screen_share_app_id=$(plutil -extract Entitlements.application-identifier raw -o - "$temp_dir/embedded-screen-share.plist")
if [[ "$embedded_screen_share_uuid" != "$expected_screen_share_profile_uuid" || "$embedded_screen_share_app_id" != "$expected_team_id.$expected_screen_share_bundle_id" ]]; then
  echo "The Chalk IPA contains an unexpected screen-share provisioning profile." >&2
  exit 1
fi

timestamp=${CHALK_RELEASE_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
version_name=$(xcodebuild -workspace "$mobile_root/ios/Chalk.xcworkspace" -scheme Chalk -configuration Release -showBuildSettings 2>/dev/null | sed -n 's/^[[:space:]]*MARKETING_VERSION = //p' | head -n 1)
build_number=$(xcodebuild -workspace "$mobile_root/ios/Chalk.xcworkspace" -scheme Chalk -configuration Release -showBuildSettings 2>/dev/null | sed -n 's/^[[:space:]]*CURRENT_PROJECT_VERSION = //p' | head -n 1)
mkdir -p "$output_dir"
output_ipa="$output_dir/chalk-ios-${version_name:-unknown}-${build_number:-unknown}-$timestamp.ipa"
cp "$built_ipa" "$output_ipa"
ditto -c -k --keepParent "$archive_path/dSYMs" "$output_dir/chalk-ios-${version_name:-unknown}-${build_number:-unknown}-$timestamp-dsyms.zip"

printf 'ios_ipa=%s\n' "$output_ipa"
printf 'certificate_sha256=%s\n' "$p12_certificate_sha256"
printf 'profile_uuid=%s\n' "$embedded_main_uuid"
printf 'screen_share_profile_uuid=%s\n' "$embedded_screen_share_uuid"
