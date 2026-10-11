#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.26.9+auto}"

describe() {
  cat <<'EOF'
Chalk API sqlc generation helper

Usage:
  apps/api/scripts/db-generate.sh [command]

Commands:
  run       Generate Go query code. This is also the default.
  check     Fail if the checked-in Go query code differs from a fresh generation. Needs no database.
  describe  Describe this helper.
  help      Show this help.

Reads:
  db/schema.sql
  db/queries

Writes:
  internal/postgres/db
EOF
}

command="${1:-run}"
case "${command}" in
  run)
    ;;
  check)
    go tool sqlc diff
    exit 0
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

go tool sqlc generate
