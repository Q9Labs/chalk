#!/usr/bin/env bash
set -euo pipefail

script_directory="$(cd "$(dirname "$0")" && pwd)"
api_root="$(cd "${script_directory}/.." && pwd)"
repository_root="$(cd "${api_root}/../.." && pwd)"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export CHALK_API_GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.13+auto}"
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN}"
export CHALK_API_ENV=local

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
  - go test -vet=off ./... and lifecycle smoke test in one lane
  - migration validation proofs in one PostgreSQL lane
  - go vet ./..., staticcheck, and govulncheck in parallel lanes

Optional:
  CHALK_API_RACE=1 apps/api/scripts/gate.sh
    Also runs: go test -race -vet=off ./...

Notes:
  This gate prepends /usr/local/go/bin when present, sets
  CHALK_API_ENV=local, and sets
  GOTOOLCHAIN=${CHALK_API_GOTOOLCHAIN:-go1.25.13+auto}.
  Isolated PostgreSQL preparation and migrations overlap database-free checks;
  database tests and lifecycle smoke wait for that PostgreSQL to be ready.
EOF
}

command="${1:-run}"
internal_database_lane=0
if [[ "${command}" == "--database-lane" ]]; then
  if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != "1" || "${CHALK_GATE_POSTGRES_CALLBACK:-0}" != "1" ]]; then
    echo "The API database lane can only run through with-postgres.sh" >&2
    exit 2
  fi
  if (($# != 1)); then
    echo "--database-lane does not accept additional arguments" >&2
    exit 2
  fi
  internal_database_lane=1
else
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
fi

cd "${api_root}"

direct_database_lane=0
if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != "1" ]]; then
  direct_database_lane=1
fi
lane_child_pid=""

run() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

run_lane_command() {
  local label="$1"
  shift
  printf '\n==> %s\n' "${label}"
  "$@" &
  lane_child_pid="$!"
  wait "${lane_child_pid}"
  local status="$?"
  lane_child_pid=""
  return "${status}"
}

database_tests_and_lifecycle() {
  run_lane_command "Tests" go test -vet=off ./... || return "$?"
  run_lane_command "Lifecycle smoke test" ./scripts/smoke-lifecycle.mjs || return "$?"
  run "Migration validation" "${script_directory}/migration-validation.sh"
}

migration_validation() {
  run "Migration validation" "${script_directory}/migration-validation.sh"
}

run_race_tests() {
  run "Race tests" go test -race -vet=off ./...
}

database_lane_cleanup() {
  if [[ -n "${lane_child_pid}" ]]; then
    kill -TERM "${lane_child_pid}" >/dev/null 2>&1 || true
    wait "${lane_child_pid}" >/dev/null 2>&1 || true
    lane_child_pid=""
  fi
}

if ((internal_database_lane)); then
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap database_lane_cleanup EXIT
  database_tests_and_lifecycle
  if [[ "${CHALK_API_RACE:-0}" == "1" ]]; then
    run_race_tests
  fi
  exit 0
fi

lane_status_dir="$(mktemp -d "${TMPDIR:-/tmp}/chalk-api-gate.XXXXXX")"
lane_pids=()
lane_labels=()
lane_status_files=()
lane_seen=()
lane_count=0
lane_cleanup_done=0

lane_signal() {
  if [[ -n "${lane_child_pid}" ]]; then
    kill -TERM "${lane_child_pid}" >/dev/null 2>&1 || true
  fi
  printf '143\n' > "${lane_status_file}.tmp"
  mv "${lane_status_file}.tmp" "${lane_status_file}"
  exit 143
}

start_lane() {
  local label="$1"
  shift
  local index="${lane_count}"
  local status_file="${lane_status_dir}/lane-${index}.status"
  lane_labels[index]="${label}"
  lane_status_files[index]="${status_file}"
  (
    set +e
    lane_status_file="${status_file}"
    trap lane_signal INT TERM
    "$@"
    status="$?"
    printf '%s\n' "${status}" > "${status_file}.tmp"
    mv "${status_file}.tmp" "${status_file}"
    exit "${status}"
  ) &
  lane_pids[index]="$!"
  lane_count=$((lane_count + 1))
}

cleanup_lanes() {
  if ((lane_cleanup_done)); then
    return
  fi
  lane_cleanup_done=1

  local pid
  for pid in "${lane_pids[@]}"; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM "${pid}" >/dev/null 2>&1 || true
    fi
  done
  for pid in "${lane_pids[@]}"; do
    wait "${pid}" >/dev/null 2>&1 || true
  done
  if [[ -d "${lane_status_dir}" ]]; then
    find "${lane_status_dir}" -depth -delete
  fi
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup_lanes EXIT

run_postgres_gate() {
  run_lane_command "Postgres preparation + database lane" \
    "${repository_root}/scripts/gates/with-postgres.sh" \
    --api-gate-db-lane -- "${script_directory}/gate.sh" --database-lane
}

if ((direct_database_lane)); then
  start_lane "Database tests + lifecycle" run_postgres_gate
else
  start_lane "Database tests + lifecycle" database_tests_and_lifecycle
fi

if ((direct_database_lane)); then
  :
else
  start_lane "Migration validation" migration_validation
fi

run "Go version" go version

printf '\n==> Format check\n'
go_files=()
while IFS= read -r go_file; do
  go_files[${#go_files[@]}]="${go_file}"
done < <(find . -name '*.go' -not -path './vendor/*' | sort)
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

start_lane "go vet" run_lane_command "go vet" go vet ./...
start_lane "Staticcheck" run_lane_command "Staticcheck" go tool staticcheck ./...
start_lane "Vulnerability check" run_lane_command "Vulnerability check" go tool govulncheck ./...

completed_lanes=0
while ((completed_lanes < lane_count)); do
  lane_progress=0
  lane_index=0
  while ((lane_index < lane_count)); do
    status_file="${lane_status_files[${lane_index}]}"
    if [[ -f "${status_file}" && -z "${lane_seen[${lane_index}]:-}" ]]; then
      status="$(<"${status_file}")"
      lane_seen[lane_index]=1
      completed_lanes=$((completed_lanes + 1))
      lane_progress=1
      if [[ "${status}" != "0" ]]; then
        echo "Lane failed: ${lane_labels[${lane_index}]} (status ${status})" >&2
        cleanup_lanes
        exit "${status}"
      fi
    fi
    lane_index=$((lane_index + 1))
  done
  if ((completed_lanes < lane_count && lane_progress == 0)); then
    sleep 0.05
  fi
done

cleanup_lanes

if [[ "${CHALK_API_RACE:-0}" == "1" && "${direct_database_lane}" == "0" ]]; then
  run_race_tests
fi

printf '\nGo API gate passed.\n'
