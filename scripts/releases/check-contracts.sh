#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."
mode="${1:---all}"
case "$mode" in --plan|--all) ;; *) echo 'usage: check-contracts.sh [--plan|--all]' >&2; exit 2 ;; esac

logs="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/chalk-release-contracts"
mkdir -p "$logs"
failed=0
check() {
  local name="$1"
  shift
  if "$@" >"$logs/$name.log" 2>&1; then
    printf 'PASS %s\n' "$name"
  else
    printf 'FAIL %s (log: %s/%s.log)\n' "$name" "$logs" "$name"
    tail -n 35 "$logs/$name.log"
    failed=1
  fi
}

if [[ "$mode" == --all ]]; then
  export TARGET_SHA="${TARGET_SHA-$(git rev-parse HEAD)}"
fi
check release-source scripts/releases/check-source.sh
if [[ "${MANAGED_ENVIRONMENT:-nightly}" == nightly ]]; then
  check dispatcher-configuration python3 scripts/releases/media.py check_configuration --environment nightly
fi
check controller infrastructure/managed-episode/scripts/test-deployment-controller
if [[ "$mode" == --plan ]]; then exit "$failed"; fi
check workspace-dependencies env CI=true pnpm install --frozen-lockfile
check dispatcher-tests pnpm --dir apps/transcription-dispatcher test
check dispatcher-contract scripts/transcription-dispatcher/validate-contract.sh
check image-shell bash -c 'for path in infrastructure/recorder/images/{cpu,capture}/*.sh; do bash -n "$path" || exit; done'
check dispatcher-init tofu -chdir=infrastructure/nightly/transcription init -backend=false -input=false -upgrade=false
check dispatcher-validate tofu -chdir=infrastructure/nightly/transcription validate -no-color
check recorder-address-init tofu -chdir=infrastructure/nightly/recording-control-address init -backend=false -input=false -upgrade=false
check recorder-address-validate tofu -chdir=infrastructure/nightly/recording-control-address validate -no-color
# GitHub supports queue:max; actionlint 1.7.12 has not added that schema key yet.
# https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency
check workflow-lint actionlint -ignore '^unexpected key "queue" for "concurrency" section' .github/workflows/ci.yml .github/workflows/nightly.yml .github/workflows/promote.yml .github/workflows/npm-publish.yml .github/workflows/release-contracts.yml
check proof-workflow-lint actionlint -ignore '^unexpected key "queue" for "concurrency" section' .github/workflows/real-call-proof.yml .github/workflows/web-call-proof.yml
printf 'Release contract logs: %s\n' "$logs"
exit "$failed"
