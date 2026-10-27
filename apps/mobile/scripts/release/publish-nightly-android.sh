#!/usr/bin/env bash
set -euo pipefail

package=ai.q9labs.chalk.mobile
release_name="nightly-$SOURCE_RUN"
require_current_cut() {
  gh api "repos/$GITHUB_REPOSITORY/deployments?environment=nightly&task=nightly-cut&per_page=1" |
    jq -e --arg run "$SOURCE_RUN" --arg sha "$SOURCE_SHA" \
      '.[0] | .sha == $sha and .payload.proof_run_id == $run and .payload.proof_result == "passed"' >/dev/null || {
    echo 'The nightly cut is no longer current; refusing a stale Android release.' >&2
    exit 1
  }
}
require_current_cut
work=$(mktemp -d "$RUNNER_TEMP/chalk-play.XXXXXX")
edit=''
cleanup() {
  if [[ -n "$edit" ]]; then gplay edits delete --package "$package" --edit "$edit" --confirm >/dev/null || true; fi
  rm -rf -- "$work"
}
trap cleanup EXIT
chmod 700 "$work"
[[ -n "$PLAY_CREDENTIALS" ]] || { echo 'Google Play publishing credentials are missing.' >&2; exit 1; }
printf '%s' "$PLAY_CREDENTIALS" > "$work/credentials.json"
chmod 600 "$work/credentials.json"
unset PLAY_CREDENTIALS
export GOOGLE_APPLICATION_CREDENTIALS="$work/credentials.json"

curl --fail --silent --show-error --location https://github.com/tamtom/play-console-cli/releases/download/v1.0.2/gplay-linux-amd64 -o "$work/gplay"
echo 'e951a13d8a35bdab43e8b4ba25ab22e45bb1487a7d27ae5b97faf2f9bb66c72e  '"$work/gplay" | sha256sum --check --status
chmod 700 "$work/gplay"
export PATH="$work:$PATH"

edit=$(gplay edits create --package "$package" | jq -er '.id')
track=$(gplay tracks get --package "$package" --edit "$edit" --track internal)
if jq -e --arg name "$release_name" 'any(.releases[]?; .name == $name and .status == "completed")' <<< "$track" >/dev/null; then
  echo "Internal track already contains $release_name."
  exit 0
fi
bundles_json=$(gplay bundles list --package "$package" --edit "$edit")
apks_json=$(gplay apks list --package "$package" --edit "$edit")
version_code=$(jq -nr --argjson bundles "$bundles_json" --argjson apks "$apks_json" \
  '([$bundles.bundles[]?.versionCode, $apks.apks[]?.versionCode] | max // 0) + 1')
gplay edits delete --package "$package" --edit "$edit" --confirm >/dev/null
edit=''

export CHALK_APP_VARIANT=nightly CHALK_ANDROID_VERSION_CODE="$version_code" SIGNED_OUTPUT_DIR="$work/output"
bash apps/mobile/scripts/release/build-signed-android.sh
mapfile -t bundles < <(find "$work/output" -maxdepth 1 -name '*.aab' -type f)
[[ ${#bundles[@]} -eq 1 ]] || { echo 'Expected exactly one signed Android bundle.' >&2; exit 1; }
require_current_cut
gplay publish track --package "$package" --track internal --bundle "${bundles[0]}" \
  --version-name "$release_name" --release-notes "Nightly build of ${SOURCE_SHA:0:12}." \
  --skip-metadata --skip-screenshots

edit=$(gplay edits create --package "$package" | jq -er '.id')
gplay tracks get --package "$package" --edit "$edit" --track internal |
  jq -e --arg name "$release_name" --arg code "$version_code" \
    'any(.releases[]?; .name == $name and .status == "completed" and any(.versionCodes[]?; . == $code))' >/dev/null
echo "Verified $release_name, version code $version_code, on the internal track."
