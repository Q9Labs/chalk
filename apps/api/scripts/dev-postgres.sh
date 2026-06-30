#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

container="${CHALK_POSTGRES_CONTAINER:-chalk-postgres}"
volume="${CHALK_POSTGRES_VOLUME:-chalk-postgres}"
image="${CHALK_POSTGRES_IMAGE:-postgres:18.3-alpine}"
port="${CHALK_POSTGRES_PORT:-5432}"
db="${CHALK_POSTGRES_DB:-chalk}"
user="${CHALK_POSTGRES_USER:-postgres}"
password="${CHALK_POSTGRES_PASSWORD:-postgres}"
expected_version="${CHALK_POSTGRES_EXPECTED_VERSION:-18.3}"
cmd="${1:-start}"

database_url="postgres://${user}:${password}@127.0.0.1:${port}/${db}?sslmode=disable"

describe() {
  cat <<'EOF'
Chalk local Postgres helper

Usage:
  apps/api/scripts/dev-postgres.sh [command]

Commands:
  start     Start or verify the local Postgres container. This is the default.
  url       Print the local CHALK_DATABASE_URL value.
  logs      Follow container logs.
  stop      Stop the container.
  rm        Remove the container but keep the named volume.
  wipe      Remove the container and named volume.
  describe  Describe this helper.
  help      Show this help.

Defaults:
  container: chalk-postgres
  volume:    chalk-postgres
  image:     postgres:18.3-alpine
  database:  chalk
  user:      postgres
  port:      5432
EOF
}

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker CLI is required. On this machine, use OrbStack's Docker-compatible CLI."
    exit 1
  fi
}

container_exists() {
  docker container inspect "${container}" >/dev/null 2>&1
}

wait_until_ready() {
  for _ in {1..60}; do
    if docker exec "${container}" pg_isready -U "${user}" -d "${db}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  echo "Postgres container started but did not become ready in time."
  docker logs "${container}" || true
  exit 1
}

verify_version() {
  local server_version

  server_version="$(docker exec "${container}" psql -U "${user}" -d "${db}" -tAc "show server_version")"
  if [[ "${server_version}" != "${expected_version}"* ]]; then
    echo "Expected Postgres ${expected_version}, got ${server_version}."
    exit 1
  fi

  echo "Postgres ${server_version} is ready."
}

case "${cmd}" in
  start)
    require_docker

    if container_exists; then
      docker start "${container}" >/dev/null
    else
      docker run \
        --name "${container}" \
        -e "POSTGRES_DB=${db}" \
        -e "POSTGRES_USER=${user}" \
        -e "POSTGRES_PASSWORD=${password}" \
        -p "127.0.0.1:${port}:5432" \
        -v "${volume}:/var/lib/postgresql" \
        -d "${image}" >/dev/null
    fi

    wait_until_ready
    verify_version
    echo "CHALK_DATABASE_URL=${database_url}"
    ;;
  stop)
    require_docker
    if container_exists; then
      docker stop "${container}" >/dev/null
      echo "Postgres stopped."
    else
      echo "Postgres container does not exist."
    fi
    ;;
  rm)
    require_docker
    if container_exists; then
      docker rm -f "${container}" >/dev/null
      echo "Postgres container removed."
    else
      echo "Postgres container does not exist."
    fi
    ;;
  wipe)
    require_docker
    if container_exists; then
      docker rm -f "${container}" >/dev/null
    fi
    docker volume rm "${volume}" >/dev/null 2>&1 || true
    echo "Postgres container and volume removed."
    ;;
  logs)
    require_docker
    docker logs -f "${container}"
    ;;
  url)
    echo "${database_url}"
    ;;
  describe | help | -h | --help)
    describe
    ;;
  *)
    echo "Unknown command: ${cmd}" >&2
    echo >&2
    describe >&2
    exit 2
    ;;
esac
