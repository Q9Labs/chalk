#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/../.."

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

check dispatcher-configuration python3 scripts/releases/media.py check_configuration --environment nightly
check controller infrastructure/managed-episode/scripts/test-deployment-controller
check managed-deploy node --test scripts/deploy/*.test.mjs
check releases python3 -m unittest discover -s scripts/releases -p 'test_*.py'
check recorder python3 -m unittest discover -s scripts/recorder -p 'test_*.py'
check recorder-node node --test scripts/recorder/*.test.mjs infrastructure/recorder/images/cpu/*.test.mjs
check dispatcher-artifacts node --test scripts/transcription-dispatcher/*.test.mjs
check image-shell bash -c 'for path in scripts/recorder/build-and-seal.sh infrastructure/recorder/images/{cpu,capture}/*.sh; do bash -n "$path" || exit; done'
check dispatcher-init tofu -chdir=infrastructure/nightly/transcription init -backend=false -input=false -upgrade=false
check dispatcher-validate tofu -chdir=infrastructure/nightly/transcription validate -no-color
check workflow-lint actionlint .github/workflows/ci.yml .github/workflows/nightly.yml .github/workflows/promote.yml .github/workflows/real-call-proof.yml .github/workflows/web-call-proof.yml .github/workflows/media-cleanup.yml
printf 'Release contract logs: %s\n' "$logs"
exit "$failed"
