#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

cmd="${1:-start}"

describe() {
  cat <<'EOF'
Chalk local services helper

Usage:
  apps/api/scripts/dev-services.sh [command]

Commands:
  start     Start or verify local Postgres and Redis containers. This is the default.
  urls      Print local CHALK_DATABASE_URL and CHALK_REDIS_URL values.
  stop      Stop local Redis, then Postgres.
  rm        Remove local Redis and Postgres containers but keep named volumes.
  wipe      Remove local Redis and Postgres containers and named volumes.
  describe  Describe this helper.
  help      Show this help.

Service-specific helpers:
  apps/api/scripts/dev-postgres.sh [command]
  apps/api/scripts/dev-redis.sh [command]
EOF
}

case "${cmd}" in
  start)
    ./scripts/dev-postgres.sh start
    ./scripts/dev-redis.sh start
    ;;
  urls)
    echo "CHALK_DATABASE_URL=$(./scripts/dev-postgres.sh url)"
    echo "CHALK_REDIS_URL=$(./scripts/dev-redis.sh url)"
    ;;
  stop | rm | wipe)
    ./scripts/dev-redis.sh "${cmd}"
    ./scripts/dev-postgres.sh "${cmd}"
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
