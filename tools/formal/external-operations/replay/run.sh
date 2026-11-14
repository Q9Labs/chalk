#!/usr/bin/env bash
# Replays the findings of ExternalOperations.tla against the real Sync code and Postgres.
# Usage: tools/formal/external-operations/replay/run.sh
# Needs Elixir, Docker (or CHALK_SYNC_TEST_DATABASE_URL), and the Sync dependencies.
# It runs the test under apps/sync, then removes the copy. On the Air, run it with
# box run -- 'bash scripts/gates/instabox-run.sh tools/formal/external-operations/replay/run.sh'.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../../.." && pwd)"
copy="$repo/apps/sync/test/chalk_sync/external_operations_findings_test.exs"

cp "$here/external_operations_findings_test.exs" "$copy"
trap 'rm -f -- "$copy"' EXIT

cd "$repo/apps/sync"
mix deps.get --check-locked
"$repo/apps/sync/scripts/with-reliability-postgres" \
  bash -c 'cd apps/sync && mix test test/chalk_sync/external_operations_findings_test.exs'
