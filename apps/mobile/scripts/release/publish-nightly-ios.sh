#!/usr/bin/env bash
# Builds the verified nightly revision and uploads it to TestFlight; the "Testers" internal group sees every build.
#   publish-nightly-ios.sh decide   writes build=true|false to $GITHUB_OUTPUT (false: nothing under the app paths changed since the last upload)
#   publish-nightly-ios.sh publish  builds, signs, uploads and checks the build
set -euo pipefail

mode=${1:?usage: publish-nightly-ios.sh decide|publish}
bundle=ai.q9labs.chalk.mobile
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
manifest="$repo_root/release/manifest.json"
# shellcheck source=op-retry.sh
source "$(dirname "${BASH_SOURCE[0]}")/op-retry.sh"
source "$repo_root/apps/mobile/scripts/release/nightly-app-paths.sh"
app_paths=("${nightly_app_paths[@]}" .github/workflows/mobile-nightly-ios.yml)

require_current_cut() {
  gh api "repos/$GITHUB_REPOSITORY/deployments?environment=nightly&task=nightly-cut&per_page=1" |
    jq -e --arg run "$SOURCE_RUN" --arg sha "$SOURCE_SHA" \
      '.[0] | .sha == $sha and .payload.proof_run_id == $run and .payload.proof_result == "passed"' >/dev/null || {
    echo 'The nightly cut is no longer current; refusing a stale iOS release.' >&2
    exit 1
  }
}

work=$(mktemp -d "$RUNNER_TEMP/chalk-testflight.XXXXXX")
trap 'find "$work" -depth -delete' EXIT
chmod 700 "$work"

# asc reads the App Store Connect key from the environment; nothing is written to the log.
curl --fail --silent --show-error --location https://github.com/rorkai/App-Store-Connect-CLI/releases/download/5.9.2/asc_5.9.2_macOS_arm64 -o "$work/asc"
echo '6d5064e6ce1bb0c3e3afe35df9b9d69c303bd30bf590bc9148f5d98dc846ab60  '"$work/asc" | shasum -a 256 --check --status
chmod 700 "$work/asc"
export PATH="$work:$PATH"

vault=$(jq -er '.vault' "$manifest")
key_item=${ASC_CREDENTIAL_ITEM_ID:?The production-signing variable ASC_CREDENTIAL_ITEM_ID is missing.}
ASC_KEY_ID=$(op_retry item get "$key_item" --vault "$vault" --fields label=key_id)
ASC_ISSUER_ID=$(op_retry item get "$key_item" --vault "$vault" --fields label=issuer_id)
echo "::add-mask::$ASC_KEY_ID"
echo "::add-mask::$ASC_ISSUER_ID"
op_retry read "op://$vault/$key_item/private_key" --out-file "$work/asc-key.p8" --force >/dev/null
chmod 600 "$work/asc-key.p8"
export ASC_KEY_ID ASC_ISSUER_ID ASC_PRIVATE_KEY_PATH="$work/asc-key.p8" ASC_BYPASS_KEYCHAIN=1 ASC_CONFIG_PATH="$work/asc-config.json"

app_id=$(asc apps list --output json | jq -er --arg bundle "$bundle" '.data[] | select(.attributes.bundleId == $bundle) | .id')
version=$(jq -er '.version_name' "$manifest")

# Nightly uploads carry "Nightly <sha>" as their TestFlight notes. The newest such build that finished processing is the last upload;
# a build that failed processing keeps its notes, and must not stop the next run from trying again.
last_uploaded_sha() {
  local build_id notes
  while IFS= read -r build_id; do
    notes=$(asc builds test-notes list --build-id "$build_id" --output json | jq -r '[.data[]?.attributes.whatsNew // empty] | join(" ")')
    if [[ "$notes" =~ Nightly\ ([0-9a-f]{40}) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return
    fi
  done < <(asc builds list --app "$app_id" --sort -uploadedDate --limit 50 --paginate --output json | jq -r '.data[] | select(.attributes.processingState == "VALID" and .attributes.expired == false) | .id')
}

if [[ "$mode" == decide ]]; then
  require_current_cut
  build=true
  last=$(last_uploaded_sha)
  if [[ "$last" == "$SOURCE_SHA" ]]; then
    echo "TestFlight already has the build of ${SOURCE_SHA:0:12}."
    build=false
  elif [[ -n "$last" ]] && git fetch --no-tags --depth=1 --filter=blob:none origin "$last" 2>/dev/null; then
    if [[ -z $(git diff --no-renames --name-only "$last" "$SOURCE_SHA" -- "${app_paths[@]}") ]]; then
      echo "Nothing under the app paths changed since the last upload (${last:0:12})."
      build=false
    fi
  fi
  echo "build=$build" >> "$GITHUB_OUTPUT"
  exit 0
fi

[[ "$mode" == publish ]] || { echo "Unknown mode $mode." >&2; exit 1; }
require_current_cut
build_number=$(asc builds next-build-number --app "$app_id" --version "$version" --platform IOS --output json | jq -er '.nextBuildNumber')
export CHALK_IOS_BUILD_NUMBER="$build_number" SIGNED_OUTPUT_DIR="$work/output"
bash "$repo_root/apps/mobile/scripts/release/build-signed-ios.sh"
# The workflow keeps the dSYMs as an artifact, because the export does not upload symbols.
mkdir -p "$RUNNER_TEMP/chalk-ios-dsyms"
cp "$work"/output/*-dsyms.zip "$RUNNER_TEMP/chalk-ios-dsyms/"
ipas=("$work"/output/*.ipa)
[[ ${#ipas[@]} -eq 1 && -f "${ipas[0]}" ]] || { echo 'Expected exactly one signed iOS IPA.' >&2; exit 1; }

require_current_cut
asc builds upload --app "$app_id" --ipa "${ipas[0]}" --test-notes "Nightly $SOURCE_SHA" --locale en-US --wait --output json > "$work/upload.json"
state=$(asc builds info --app "$app_id" --build-number "$build_number" --version "$version" --platform IOS --output json | jq -er '.data.attributes.processingState')
[[ "$state" == VALID ]] || { echo "TestFlight reports build $build_number as $state." >&2; exit 1; }
echo "Verified TestFlight build $build_number of ${SOURCE_SHA:0:12}, version $version."
