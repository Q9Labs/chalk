#!/usr/bin/env bash
# Prints the next free Google Play versionCode: one above every bundle and APK on Play.
# Nightly builds and store releases both take their code from here, so they cannot collide.
# Needs gplay signed in to the Play account.
set -euo pipefail

package=${1:-ai.q9labs.chalk.mobile}
edit=$(gplay edits create --package "$package" | jq -er '.id')
trap 'gplay edits delete --package "$package" --edit "$edit" --confirm >/dev/null' EXIT
bundles_json=$(gplay bundles list --package "$package" --edit "$edit")
apks_json=$(gplay apks list --package "$package" --edit "$edit")
jq -nr --argjson bundles "$bundles_json" --argjson apks "$apks_json" \
  '([$bundles.bundles[]?.versionCode, $apks.apks[]?.versionCode] | max // 0) + 1'
