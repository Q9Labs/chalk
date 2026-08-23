#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "with-sync-topology.sh requires at least one command" >&2
  exit 2
fi

command_mode=0
if [[ "$1" == "--" ]]; then
  command_mode=1
  shift
  if (($# == 0)); then
    echo "with-sync-topology.sh -- requires a command" >&2
    exit 2
  fi
fi

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
topology_root="$(mktemp -d "${TMPDIR:-/tmp}/chalk-sync-topology.XXXXXX")"
backend=""

available_port() {
  ruby -rsocket -e \
    'server = TCPServer.new("127.0.0.1", 0); puts server.addr[1]; server.close'
}

postgres_ready() {
  local pg_bin="$1"
  local port="$2"
  "${pg_bin}/psql" \
    -h 127.0.0.1 \
    -p "${port}" \
    -U postgres \
    -d chalk_reliability \
    -Atqc "select 1" >/dev/null 2>&1
}

wait_for_native_postgres() {
  local pg_bin="$1"
  local port="$2"

  for _ in {1..100}; do
    postgres_ready "${pg_bin}" "${port}" && return 0
    sleep 0.05
  done

  return 1
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

start_native_topology() {
  local pg_bin="$1"
  local primary_data="${topology_root}/primary"
  local standby_data="${topology_root}/standby"
  local primary_port
  local standby_port
  primary_port="$(available_port)"
  standby_port="$(available_port)"

  backend="native"
  export CHALK_SYNC_TOPOLOGY_BACKEND="${backend}"
  export CHALK_SYNC_TOPOLOGY_PG_BIN="${pg_bin}"
  export CHALK_SYNC_TOPOLOGY_PRIMARY_DATA="${primary_data}"
  export CHALK_SYNC_TOPOLOGY_STANDBY_DATA="${standby_data}"
  export CHALK_SYNC_TOPOLOGY_PRIMARY_PORT="${primary_port}"
  export CHALK_SYNC_TOPOLOGY_STANDBY_PORT="${standby_port}"

  "${pg_bin}/initdb" -D "${primary_data}" -A trust -U postgres >/dev/null
  "${pg_bin}/pg_ctl" \
    -D "${primary_data}" \
    -l "${topology_root}/primary.log" \
    -o "-h 127.0.0.1 -p ${primary_port} -c wal_level=replica -c max_wal_senders=8" \
    start >/dev/null
  "${pg_bin}/createdb" -h 127.0.0.1 -p "${primary_port}" -U postgres chalk_reliability

  export CHALK_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${primary_port}/chalk_reliability?sslmode=disable"
  "${repository_root}/apps/api/scripts/db-migrate.sh" up

  "${pg_bin}/pg_basebackup" \
    -h 127.0.0.1 \
    -p "${primary_port}" \
    -U postgres \
    -D "${standby_data}" \
    -R \
    --checkpoint=fast \
    -X stream >/dev/null
  "${pg_bin}/pg_ctl" \
    -D "${standby_data}" \
    -l "${topology_root}/standby.log" \
    -o "-h 127.0.0.1 -p ${standby_port} -c hot_standby=on" \
    start >/dev/null
  wait_for_native_postgres "${pg_bin}" "${standby_port}"

  export CHALK_SYNC_TEST_DATABASE_URL="${CHALK_DATABASE_URL}"
}

docker_binary() {
  if command -v docker >/dev/null 2>&1; then
    command -v docker
  elif [[ -x /Users/macmini/.orbstack/bin/docker ]]; then
    printf '%s\n' "/Users/macmini/.orbstack/bin/docker"
  else
    return 1
  fi
}

docker_port() {
  local docker_bin="$1"
  local container="$2"
  "${docker_bin}" port "${container}" 5432/tcp | awk -F: 'END {print $NF}'
}

wait_for_docker_postgres() {
  local docker_bin="$1"
  local container="$2"

  for _ in {1..120}; do
    if "${docker_bin}" exec "${container}" \
      psql -U postgres -d chalk_reliability -Atqc "select 1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  return 1
}

start_docker_topology() {
  local docker_bin="$1"
  local suffix
  local network
  local primary
  local standby
  local standby_volume
  local primary_port
  local standby_port
  suffix="$(basename "${topology_root}")-$$"
  network="chalk-sync-topology-${suffix}"
  primary="chalk-sync-primary-${suffix}"
  standby="chalk-sync-standby-${suffix}"
  standby_volume="chalk-sync-standby-${suffix}"

  backend="docker"
  export CHALK_SYNC_TOPOLOGY_BACKEND="${backend}"
  export CHALK_SYNC_TOPOLOGY_DOCKER_BIN="${docker_bin}"
  export CHALK_SYNC_TOPOLOGY_PRIMARY_CONTAINER="${primary}"
  export CHALK_SYNC_TOPOLOGY_STANDBY_CONTAINER="${standby}"
  export CHALK_SYNC_TOPOLOGY_NETWORK="${network}"
  export CHALK_SYNC_TOPOLOGY_STANDBY_VOLUME="${standby_volume}"

  "${docker_bin}" network create "${network}" >/dev/null
  "${docker_bin}" volume create "${standby_volume}" >/dev/null
  "${docker_bin}" run \
    --name "${primary}" \
    --network "${network}" \
    -e POSTGRES_DB=chalk_reliability \
    -e POSTGRES_USER=postgres \
    -e POSTGRES_PASSWORD=postgres \
    -p 127.0.0.1::5432 \
    -d postgres:18.3-alpine \
    -c wal_level=replica \
    -c max_wal_senders=8 >/dev/null
  wait_for_docker_postgres "${docker_bin}" "${primary}"
  primary_port="$(docker_port "${docker_bin}" "${primary}")"

  export CHALK_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${primary_port}/chalk_reliability?sslmode=disable"
  "${repository_root}/apps/api/scripts/db-migrate.sh" up

  "${docker_bin}" exec "${primary}" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "create role chalk_replicator with replication login password 'replicator';" >/dev/null

  # The container shell expands PGDATA.
  # shellcheck disable=SC2016
  "${docker_bin}" exec "${primary}" \
    sh -c 'printf "%s\n" "host replication chalk_replicator 0.0.0.0/0 scram-sha-256" >> "$PGDATA/pg_hba.conf"'
  "${docker_bin}" exec "${primary}" \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "select pg_reload_conf();" >/dev/null

  # The container shell expands PGDATA and $1.
  # shellcheck disable=SC2016
  "${docker_bin}" run --rm \
    --network "${network}" \
    -e PGPASSWORD=replicator \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v "${standby_volume}:/var/lib/postgresql/data" \
    postgres:18.3-alpine \
    sh -c 'mkdir -p "$PGDATA" && chown postgres:postgres "$PGDATA" && if command -v gosu >/dev/null; then exec gosu postgres pg_basebackup -h "$1" -U chalk_replicator -D "$PGDATA" -R --checkpoint=fast -X stream; else exec su-exec postgres pg_basebackup -h "$1" -U chalk_replicator -D "$PGDATA" -R --checkpoint=fast -X stream; fi' \
    sh "${primary}" >/dev/null

  "${docker_bin}" run \
    --name "${standby}" \
    --network "${network}" \
    -e POSTGRES_PASSWORD=postgres \
    -e PGDATA=/var/lib/postgresql/data/pgdata \
    -v "${standby_volume}:/var/lib/postgresql/data" \
    -p 127.0.0.1::5432 \
    -d postgres:18.3-alpine \
    -c hot_standby=on >/dev/null
  wait_for_docker_postgres "${docker_bin}" "${standby}"
  standby_port="$(docker_port "${docker_bin}" "${standby}")"

  export CHALK_SYNC_TOPOLOGY_PRIMARY_PORT="${primary_port}"
  export CHALK_SYNC_TOPOLOGY_STANDBY_PORT="${standby_port}"
  export CHALK_SYNC_TEST_DATABASE_URL="${CHALK_DATABASE_URL}"
}

cleanup() {
  if [[ "${backend}" == "native" ]]; then
    "${CHALK_SYNC_TOPOLOGY_PG_BIN}/pg_ctl" \
      -D "${CHALK_SYNC_TOPOLOGY_STANDBY_DATA}" \
      -m immediate \
      stop >/dev/null 2>&1 || true
    "${CHALK_SYNC_TOPOLOGY_PG_BIN}/pg_ctl" \
      -D "${CHALK_SYNC_TOPOLOGY_PRIMARY_DATA}" \
      -m immediate \
      stop >/dev/null 2>&1 || true
  elif [[ "${backend}" == "docker" ]]; then
    "${CHALK_SYNC_TOPOLOGY_DOCKER_BIN}" rm -f \
      "${CHALK_SYNC_TOPOLOGY_PRIMARY_CONTAINER}" \
      "${CHALK_SYNC_TOPOLOGY_STANDBY_CONTAINER}" >/dev/null 2>&1 || true
    "${CHALK_SYNC_TOPOLOGY_DOCKER_BIN}" volume rm \
      "${CHALK_SYNC_TOPOLOGY_STANDBY_VOLUME}" >/dev/null 2>&1 || true
    "${CHALK_SYNC_TOPOLOGY_DOCKER_BIN}" network rm \
      "${CHALK_SYNC_TOPOLOGY_NETWORK}" >/dev/null 2>&1 || true
  fi

  rm -rf "${topology_root}"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "${repository_root}"
if pg_bin="$(native_pg18_bin)"; then
  start_native_topology "${pg_bin}"
elif docker_bin="$(docker_binary)"; then
  start_docker_topology "${docker_bin}"
else
  echo "PostgreSQL 18 binaries or Docker are required for the Sync topology profile" >&2
  exit 127
fi

if ((command_mode == 1)); then
  "$@"
else
  for command in "$@"; do
    "${command}"
  done
fi
