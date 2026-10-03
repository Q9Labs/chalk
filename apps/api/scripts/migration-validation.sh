#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"

# Each proof starts its own PostgreSQL, so a stuck container or migration would otherwise hang the gate silently.
proof_timeout_seconds="${CHALK_MIGRATION_PROOF_TIMEOUT_SECONDS:-900}"

run_proof() {
  local label="$1"
  shift
  printf '\n==> %s\n' "${label}"
  "${repository_root}/scripts/gates/with-timeout.sh" "${proof_timeout_seconds}" "${label}" -- "$@"
}

run_proof "Sync migration proof dependencies" bash -c 'cd "$1/apps/sync" && env MIX_ENV=test mix deps.get --check-locked' _ "${repository_root}"
run_proof "Membership role migration" "${repository_root}/apps/api/scripts/membership-role-migration-test.sh" "$@"
run_proof "Space/Episode bridge migration" "${repository_root}/apps/api/scripts/space-episode-bridge-migration-test.sh" "$@"
run_proof "Sync retained-event repair migration" "${repository_root}/apps/api/scripts/sync-retained-event-schema-repair-migration-test.sh" "$@"
run_proof "Episode control snapshot repair migration" "${repository_root}/apps/api/scripts/episode-control-snapshot-repair-migration-test.sh" "$@"
run_proof "Recording release upgrade from pre-recording history" bash "${repository_root}/apps/api/scripts/recording-release-migration-test.sh" "$@"
