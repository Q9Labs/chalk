#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

describe() {
  cat <<'EOF'
Chalk API sqlc generation helper

Usage:
  apps/api/scripts/db-generate.sh [command]

Commands:
  run       Generate Go query code. This is also the default.
  describe  Describe this helper.
  help      Show this help.

Reads:
  db/migrations
  db/queries

Writes:
  internal/postgres/db
EOF
}

command="${1:-run}"
case "${command}" in
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

go tool sqlc generate
