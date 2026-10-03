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
  describe  Describe what the gate checks.
  help      Show this help.

Checks:
  - elixir version
  - mix deps.get (check lockfile is honored)
  - mix format --check-formatted, non-mutating
  - mix compile --warnings-as-errors (test env, compiles test support too)
  - mix credo --strict
  - PostgreSQL-backed mix test with zero skipped cases
EOF
}

command="${1:-${CHALK_SYNC_GATE_MODE:-run}}"
case "$command" in
  run | basic) ;;
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

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

run "Elixir version" elixir --version
run "Dependencies" mix deps.get --check-locked
run "Format check" mix format --check-formatted
run "Compile (warnings as errors)" env MIX_ENV=test mix compile --warnings-as-errors

if [[ "$command" == "basic" ]]; then
  printf '\nSync server basic gate passed.\n'
  exit 0
fi

if [[ -z "${CHALK_SYNC_TEST_DATABASE_URL:-${CHALK_DATABASE_URL:-}}" ]]; then
  echo "The full Sync gate requires CHALK_SYNC_TEST_DATABASE_URL" >&2
  exit 2
fi

# The SDK campaign imports the built diagnostics-contracts package, which a fresh checkout lacks.
repository_root="$(cd ../.. && pwd)"
if [[ ! -f "${repository_root}/packages/diagnostics-contracts/dist/index.js" ]]; then
  if [[ ! -d "${repository_root}/node_modules/.bin" ]]; then
    echo "node_modules is missing; run 'pnpm install --frozen-lockfile' at the repository root" >&2
    exit 2
  fi
  run "Build diagnostics-contracts" pnpm --dir "${repository_root}/packages/diagnostics-contracts" run build
fi

# Bounded so a hung test run fails with a clear message instead of stalling the gate.
test_timeout_seconds="${CHALK_SYNC_TEST_TIMEOUT_SECONDS:-1800}"
run "Credo" "${repository_root}/scripts/gates/with-timeout.sh" 600 "Sync Credo" -- mix credo --strict
run "Tests (zero skips)" "${repository_root}/scripts/gates/with-timeout.sh" "${test_timeout_seconds}" "Sync tests" -- scripts/test-strict --max-cases "${CHALK_SYNC_TEST_MAX_CASES:-10}"

printf '\nSync server gate passed.\n'
