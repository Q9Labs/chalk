#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

if [[ $GITHUB_EVENT_NAME == pull_request ]]; then
  web=chalk-helper-smoke.invalid
  api=$web
  sync=$web
  # The smoke test exercises the real loopback listener without a managed account.
  key=$(node -e 'process.stdout.write(require("node:crypto").generateKeyPairSync("ed25519").publicKey.export({format:"jwk"}).x)')
else
  case "$CHANNEL" in
    staging) web=nightly.chalkmeet.com; api=nightly-api.chalkmeet.com; sync=nightly-sync.chalkmeet.com ;;
    production) web=chalkmeet.com; api=api.chalkmeet.com; sync=sync.chalkmeet.com ;;
    *) exit 1 ;;
  esac
  key=$PAIR_TICKET_KEY
  [[ $key =~ ^[A-Za-z0-9_-]{43}$ ]] || {
    echo "::error::Set the channel's CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY."
    exit 1
  }
fi

test -f ../../packages/screen-annotation/src/index.ts
{
  echo "CHALK_HELPER_WEB_ORIGIN=https://$web"
  echo "CHALK_HELPER_API_ORIGIN=https://$api"
  echo "CHALK_HELPER_SYNC_ORIGIN=wss://$sync"
  echo "CHALK_HELPER_PAIR_TICKET_PUBLIC_KEY=$key"
} >> "$GITHUB_ENV"

if [[ $1 == macos ]]; then
  key=$(cat "release/$CHANNEL.pub")
  {
    echo "CHALK_HELPER_UPDATE_ENDPOINT=$DOWNLOAD_ORIGIN/helper/$CHANNEL/latest.json"
    echo "CHALK_HELPER_UPDATE_PUBLIC_KEY=$key"
  } >> "$GITHUB_ENV"
  jq -n --arg key "$key" \
    '{plugins: {updater: {pubkey: $key, requireSignedVersion: true}}, bundle: {createUpdaterArtifacts: true}}' \
    > "$RUNNER_TEMP/macos.json"
fi
