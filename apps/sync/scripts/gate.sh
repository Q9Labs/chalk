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
  - mix test
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

run "Credo" mix credo --strict
run "Tests" mix test --max-cases "${CHALK_SYNC_TEST_MAX_CASES:-10}"

printf '\nSync server gate passed.\n'
