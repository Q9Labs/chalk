#!/usr/bin/env bash
set -euo pipefail

if (($# == 0)); then
  echo "with-postgres.sh requires at least one gate command" >&2
  exit 2
fi

if command -v docker >/dev/null 2>&1; then
  docker_bin="$(command -v docker)"
elif [[ -x /Users/macmini/.orbstack/bin/docker ]]; then
  docker_bin="/Users/macmini/.orbstack/bin/docker"
else
  echo "Docker is required to provision the gate's isolated PostgreSQL service" >&2
  exit 127
fi

suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
container="chalk-gate-postgres-${suffix}"

cleanup() {
  "${docker_bin}" rm -f "${container}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

"${docker_bin}" run \
  --name "${container}" \
  -e POSTGRES_DB=chalk_gate \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -p 127.0.0.1::5432 \
  -d postgres:18.3-alpine >/dev/null

postgres_ready() {
  # pg_isready can succeed against the entrypoint's temporary bootstrap server
  # immediately before that server shuts down. Wait until PostgreSQL is PID 1,
  # then prove the configured database accepts a real query.
  "${docker_bin}" exec "${container}" sh -c 'test "$(cat /proc/1/comm)" = postgres' >/dev/null 2>&1 &&
    "${docker_bin}" exec "${container}" psql -U postgres -d chalk_gate -v ON_ERROR_STOP=1 -Atqc 'select 1' >/dev/null 2>&1
}

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

port="$("${docker_bin}" port "${container}" 5432/tcp | awk -F: 'END {print $NF}')"
if [[ ! "${port}" =~ ^[0-9]+$ ]]; then
  echo "Could not resolve the gate PostgreSQL port" >&2
  exit 1
fi

database_url="postgres://postgres:postgres@127.0.0.1:${port}/chalk_gate?sslmode=disable"
CHALK_DATABASE_URL="${database_url}" apps/api/scripts/db-migrate.sh up

export CHALK_DATABASE_URL="${database_url}"
export CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL="${database_url}"
export CHALK_SYNC_TEST_DATABASE_URL="${database_url}"

for gate in "$@"; do
  "${gate}"
done
