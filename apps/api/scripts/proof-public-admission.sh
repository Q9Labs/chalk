#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != 1 ]]; then
  exec bash scripts/gates/with-postgres.sh -- bash apps/api/scripts/proof-public-admission.sh "$@"
fi
archive_proof() {
  if [[ -n "${CHALK_ADMISSION_PROOF_ARCHIVE:-}" && -d artifacts/fix-admit ]]; then
    tar -czf "$CHALK_ADMISSION_PROOF_ARCHIVE" artifacts/fix-admit
  fi
}
trap archive_proof EXIT
if [[ "${1:-}" == "--observability" ]]; then
  CHALK_ADMISSION_OBSERVABILITY_E2E=1 go test -C apps/api -vet=off ./internal/adapters/postgres -run '^TestPublicAdmissionObservabilityE2E$' -timeout 12m -v -count=1
  exit
fi
go test -C apps/api -vet=off ./internal/adapters/postgres -run '^TestDashboardCallPublicKnockReachesEpisodeAdmission$' -v -count=1
DASHBOARD_ENGINE_DEADLINE_SECONDS=600 bash apps/web/tests/dashboard/real-engine.sh pnpm --filter web exec node tests/dashboard/join-browser.mjs --admission
