#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

describe() {
  cat <<'EOF'
Chalk sync server gate

Usage:
  apps/sync/scripts/gate.sh [command]

Commands:
  run       Run the full gate. This is also the default.
  basic     Check locked dependencies, formatting, and compilation only.
  deps      Fetch the locked dependencies only.
  describe  Describe what the gate checks.
  help      Show this help.

Checks:
  - elixir version
  - mix deps.get (check lockfile is honored)
  - mix format --check-formatted, non-mutating
  - mix compile --warnings-as-errors (test env, compiles test support too)
  - mix xref graph --format cycles --fail-above 0 (no module cycle under lib/)
  - mix credo --strict
  - PostgreSQL-backed mix test with zero skipped cases
  - Real API bridge readiness while Cloudflare cleanup is blocked
EOF
}

command="${1:-${CHALK_SYNC_GATE_MODE:-run}}"
case "$command" in
  run | basic | deps) ;;
  describe | help | -h | --help)
    describe
    exit 0
    ;;
  *)
    echo "Unknown command: ${command}" >&2
    echo >&2
    describe >&2
    exit 2
    ;;
esac

# A Hex download can fail for a moment, so a failed fetch is retried a bounded number of times.
fetch_dependencies() {
  local delay
  for delay in 10 30 0; do
    mix deps.get --check-locked && return 0
    ((delay)) || break
    echo "mix deps.get failed; retrying in ${delay}s" >&2
    sleep "$delay"
  done
  return 1
}

if [[ "$command" == "deps" ]]; then
  fetch_dependencies
  exit
fi

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

run "Elixir version" elixir --version
run "Dependencies" fetch_dependencies
run "Format check" mix format --check-formatted
run "Compile (warnings as errors)" env MIX_ENV=test mix compile --warnings-as-errors
run "Module cycles" env MIX_ENV=test mix xref graph --format cycles --fail-above 0

if [[ "$command" == "basic" ]]; then
  printf '\nSync server basic gate passed.\n'
  exit 0
fi

if [[ -z "${CHALK_SYNC_TEST_DATABASE_URL:-${CHALK_DATABASE_URL:-}}" ]]; then
  echo "The full Sync gate requires CHALK_SYNC_TEST_DATABASE_URL" >&2
  exit 2
fi

repository_root="$(cd ../.. && pwd)"

# Bounded so a hung test run fails with a clear message instead of stalling the gate.
test_timeout_seconds="${CHALK_SYNC_TEST_TIMEOUT_SECONDS:-1800}"
run "Credo" "${repository_root}/scripts/gates/with-timeout.sh" 600 "Sync Credo" -- mix credo --strict
run "Tests (zero skips)" "${repository_root}/scripts/gates/with-timeout.sh" "${test_timeout_seconds}" "Sync tests" -- scripts/test-strict --max-cases "${CHALK_SYNC_TEST_MAX_CASES:-10}"
run "Provider bridge readiness" "${repository_root}/scripts/gates/with-timeout.sh" 300 "Provider bridge readiness" -- scripts/provider-bridge-readiness-test

printf '\nSync server gate passed.\n'
