#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

container="${CHALK_REDIS_CONTAINER:-chalk-redis}"
volume="${CHALK_REDIS_VOLUME:-chalk-redis}"
image="${CHALK_REDIS_IMAGE:-redis:8.8.0-alpine}"
port="${CHALK_REDIS_PORT:-6379}"
expected_version="${CHALK_REDIS_EXPECTED_VERSION:-8.8.0}"
cmd="${1:-start}"

redis_url="redis://127.0.0.1:${port}/0"

describe() {
  cat <<'EOF'
Chalk local Redis helper

Usage:
  apps/api/scripts/dev-redis.sh [command]

Commands:
  start     Start or verify the local Redis container. This is the default.
  url       Print the local CHALK_REDIS_URL value.
  logs      Follow container logs.
  stop      Stop the container.
  rm        Remove the container but keep the named volume.
  wipe      Remove the container and named volume.
  describe  Describe this helper.
  help      Show this help.

Defaults:
  container: chalk-redis
  volume:    chalk-redis
  image:     redis:8.8.0-alpine
  port:      6379
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
    if docker exec "${container}" redis-cli ping >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done

  echo "Redis container started but did not become ready in time."
  docker logs "${container}" || true
  exit 1
}

verify_version() {
  local server_version

  server_version="$(docker exec "${container}" redis-server --version | awk '{print $3}' | sed 's/^v=//')"
  if [[ "${server_version}" != "${expected_version}"* ]]; then
    echo "Expected Redis ${expected_version}, got ${server_version}."
    exit 1
  fi

  echo "Redis ${server_version} is ready."
}

case "${cmd}" in
  start)
    require_docker

    if container_exists; then
      docker start "${container}" >/dev/null
    else
      docker run \
        --name "${container}" \
        -p "127.0.0.1:${port}:6379" \
        -v "${volume}:/data" \
        -d "${image}" >/dev/null
    fi

    wait_until_ready
    verify_version
    echo "CHALK_REDIS_URL=${redis_url}"
    ;;
  stop)
    require_docker
    if container_exists; then
      docker stop "${container}" >/dev/null
      echo "Redis stopped."
    else
      echo "Redis container does not exist."
    fi
    ;;
  rm)
    require_docker
    if container_exists; then
      docker rm -f "${container}" >/dev/null
      echo "Redis container removed."
    else
      echo "Redis container does not exist."
    fi
    ;;
  wipe)
    require_docker
    if container_exists; then
      docker rm -f "${container}" >/dev/null
    fi
    docker volume rm "${volume}" >/dev/null 2>&1 || true
    echo "Redis container and volume removed."
    ;;
  logs)
    require_docker
    docker logs -f "${container}"
    ;;
  url)
    echo "${redis_url}"
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
