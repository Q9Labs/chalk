#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "with-postgres.sh requires at least one gate command" >&2
  exit 2
fi

command_mode=0
if [[ "$1" == "--" ]]; then
  command_mode=1
  shift
  if (($# == 0)); then
    echo "with-postgres.sh -- requires a command" >&2
    exit 2
  fi
fi

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
backend=""
docker_bin=""
container=""
native_root=""
native_pg_bin=""

docker_binary() {
  local candidate
  if command -v docker >/dev/null 2>&1; then
    candidate="$(command -v docker)"
  elif [[ -x /Users/macmini/.orbstack/bin/docker ]]; then
    candidate="/Users/macmini/.orbstack/bin/docker"
  else
    return 1
  fi

  "${candidate}" info >/dev/null 2>&1 || return 1
  printf '%s\n' "${candidate}"
}

native_pg18_bin() {
  local candidates=(
    "${CHALK_SYNC_PG18_BIN:-}"
    "/opt/homebrew/opt/postgresql@18/bin"
    "/usr/local/opt/postgresql@18/bin"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -x "${candidate}/postgres" ]] &&
       [[ "$("${candidate}/pg_config" --version)" == PostgreSQL\ 18.* ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done

  return 1
}

available_port() {
  ruby -rsocket -e \
    'server = TCPServer.new("127.0.0.1", 0); puts server.addr[1]; server.close'
}

cleanup() {
  if [[ "${backend}" == "docker" ]]; then
    "${docker_bin}" rm -f "${container}" >/dev/null 2>&1 || true
  elif [[ "${backend}" == "native" ]]; then
    if [[ -n "${native_root}" && "$(basename "${native_root}")" == chalk-gate-postgres.* ]]; then
      "${native_pg_bin}/pg_ctl" \
        -D "${native_root}/data" \
        -m immediate \
        stop >/dev/null 2>&1 || true
      rm -rf "${native_root}"
    fi
  fi
}
trap cleanup EXIT INT TERM

postgres_ready() {
  # The container shell expands /proc state.
  # shellcheck disable=SC2016
  "${docker_bin}" exec "${container}" sh -c 'test "$(cat /proc/1/comm)" = postgres' >/dev/null 2>&1 &&
    "${docker_bin}" exec "${container}" \
      psql -U postgres -d chalk_gate -v ON_ERROR_STOP=1 -Atqc 'select 1' >/dev/null 2>&1
}

start_docker_postgres() {
  container="chalk-gate-postgres-${suffix}"
  "${docker_bin}" run \
    --name "${container}" \
    -e POSTGRES_DB=chalk_gate \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -p 127.0.0.1::5432 \
    -d postgres:18.3-alpine >/dev/null

  for _ in {1..60}; do
    if postgres_ready; then
      break
    fi
    sleep 0.5
  done

  if ! postgres_ready; then
    echo "Gate PostgreSQL service did not become ready" >&2
    "${docker_bin}" logs "${container}" >&2 || true
    exit 1
  fi

  local port
  port="$("${docker_bin}" port "${container}" 5432/tcp | awk -F: 'END {print $NF}')"
  if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
    echo "Could not resolve the gate PostgreSQL port" >&2
    exit 1
  fi

  export_database_url "${port}"
}

start_native_postgres() {
  native_root="$(mktemp -d "${TMPDIR:-/tmp}/chalk-gate-postgres.XXXXXX")"
  local port
  port="$(available_port)"

  "${native_pg_bin}/initdb" -D "${native_root}/data" -A trust -U postgres >/dev/null
  "${native_pg_bin}/pg_ctl" \
    -D "${native_root}/data" \
    -l "${native_root}/postgres.log" \
    -o "-h 127.0.0.1 -p ${port}" \
    -w \
    start >/dev/null
  "${native_pg_bin}/createdb" -h 127.0.0.1 -p "${port}" -U postgres chalk_gate
  export_database_url "${port}"
}

export_database_url() {
  local port="$1"
  local database_url
  database_url="postgres://postgres:postgres@127.0.0.1:${port}/chalk_gate?sslmode=disable"

  if [[ -n "${CHALK_GATE_POSTGRES_MIGRATION_TARGET:-}" ]]; then
    if [[ ! "${CHALK_GATE_POSTGRES_MIGRATION_TARGET}" =~ ^[0-9]+$ ]]; then
      echo "CHALK_GATE_POSTGRES_MIGRATION_TARGET must be a numeric Goose version" >&2
      exit 2
    fi
    CHALK_DATABASE_URL="${database_url}" "${repository_root}/apps/api/scripts/db-migrate.sh" up-to "${CHALK_GATE_POSTGRES_MIGRATION_TARGET}"
  else
    CHALK_DATABASE_URL="${database_url}" "${repository_root}/apps/api/scripts/db-migrate.sh" up
  fi

  export CHALK_API_ENV=local
  export CHALK_GATE_POSTGRES_READY=1
  export CHALK_DATABASE_URL="${database_url}"
  export CHALK_CHAT_ATTACHMENT_TEST_DATABASE_URL="${database_url}"
  export CHALK_EPISODE_DIAGNOSTICS_TEST_DATABASE_URL="${database_url}"
  export CHALK_PROVIDER_BRIDGE_E2E_DATABASE_URL="${database_url}"
  export CHALK_SPACE_LIFECYCLE_TEST_DATABASE_URL="${database_url}"
  export CHALK_STATUS_TEST_DATABASE_URL="${database_url}"
  export CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL="${database_url}"
  export CHALK_SYNC_TEST_DATABASE_URL="${database_url}"
  export CHALK_TENANT_ONBOARDING_TEST_DATABASE_URL="${database_url}"
  export CHALK_WEBHOOK_TEST_DATABASE_URL="${database_url}"
  export CHALK_WHITEBOARD_TEST_DATABASE_URL="${database_url}"
}

if docker_bin="$(docker_binary)"; then
  backend="docker"
  start_docker_postgres
elif native_pg_bin="$(native_pg18_bin)"; then
  backend="native"
  start_native_postgres
else
  echo "Docker or PostgreSQL 18 binaries are required for the isolated gate database" >&2
  exit 127
fi

cd "${repository_root}"
if ((command_mode == 1)); then
  "$@"
else
  for gate in "$@"; do
    "${gate}"
  done
fi
