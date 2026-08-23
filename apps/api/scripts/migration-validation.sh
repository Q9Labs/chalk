#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"

run_proof() {
  local label="$1"
  shift
  printf '\n==> %s\n' "${label}"
  "$@"
}

run_proof "Membership role migration" "${repository_root}/apps/api/scripts/membership-role-migration-test.sh" "$@"
run_proof "Space/Episode bridge migration" "${repository_root}/apps/api/scripts/space-episode-bridge-migration-test.sh" "$@"
run_proof "Sync retained-event repair migration" "${repository_root}/apps/api/scripts/sync-retained-event-schema-repair-migration-test.sh" "$@"
run_proof "Episode control snapshot repair migration" "${repository_root}/apps/api/scripts/episode-control-snapshot-repair-migration-test.sh" "$@"
