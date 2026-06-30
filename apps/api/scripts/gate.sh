#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

describe() {
  cat <<'EOF'
Chalk Go API gate

Usage:
  apps/api/scripts/gate.sh [command]

Commands:
  run       Run the full gate. This is also the default.
  describe  Describe what the gate checks.
  help      Show this help.

Checks:
  - go version
  - gofmt check, non-mutating
  - go mod tidy -diff
  - go tool sqlc vet
  - go test ./...
  - lifecycle smoke test: build binary, wait for /healthz, send SIGTERM
  - go vet ./...
  - go tool staticcheck ./...
  - go tool govulncheck ./...

Optional:
  CHALK_API_RACE=1 apps/api/scripts/gate.sh
    Also runs: go test -race ./...

Notes:
  This gate prepends /usr/local/go/bin when present and sets
  GOTOOLCHAIN=${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}.
EOF
}

command="${1:-run}"
case "$command" in
  run)
    ;;
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

run "Go version" go version

printf '\n==> Format check\n'
mapfile -t go_files < <(find . -name '*.go' -not -path './vendor/*' | sort)
if ((${#go_files[@]} > 0)); then
  unformatted="$(gofmt -l "${go_files[@]}")"
  if [[ -n "$unformatted" ]]; then
    echo "These Go files need gofmt:"
    echo "$unformatted"
    echo
    echo "Run: apps/api/scripts/format.sh"
    exit 1
  fi
fi

run "Module tidy check" go mod tidy -diff
run "sqlc vet" go tool sqlc vet
run "Tests" go test ./...
run "Lifecycle smoke test" ./scripts/smoke-lifecycle.mjs
run "go vet" go vet ./...
run "Staticcheck" go tool staticcheck ./...
run "Vulnerability check" go tool govulncheck ./...

if [[ "${CHALK_API_RACE:-0}" == "1" ]]; then
  run "Race tests" go test -race ./...
fi

printf '\nGo API gate passed.\n'
