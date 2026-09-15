#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/chalk-capture-profile.XXXXXX")"
trap 'rm -rf -- "$fixture"' EXIT
cd "$repo_root/apps/api"
export GOMAXPROCS=1 GOMEMLIMIT=512MiB
go test -c -o "$fixture/capture-profile.test" ./internal/recorderworker
node "$repo_root/scripts/recorder/measure-command.mjs" --evidence "$fixture/evidence.json" --label deterministic-local -- \
  "$fixture/capture-profile.test" -test.run='^$' -test.bench='^BenchmarkCaptureThreeParticipantsHour$' -test.benchtime=1x
echo 'RESOURCE-ONLY: compressed-time synthetic RTP, 3 Participants, 4 Mbps, 1 hour; no cloud/SFU/network/renderer qualification.'
echo 'Shared-CPU candidates remain disabled. Separately authorize the full paced cloud scenario and ten-way post-processing measurement.'
