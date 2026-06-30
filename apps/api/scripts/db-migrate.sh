#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

describe() {
  cat <<'EOF'
Chalk API migration helper

Usage:
  apps/api/scripts/db-migrate.sh [goose-command] [args...]

Examples:
  apps/api/scripts/db-migrate.sh status
  apps/api/scripts/db-migrate.sh up
  apps/api/scripts/db-migrate.sh down
  apps/api/scripts/db-migrate.sh version

Notes:
  Defaults to CHALK_DATABASE_URL when set; otherwise uses
  apps/api/scripts/dev-postgres.sh url.
  For managed Postgres, run migrations through the direct database URL, not a
  pooled runtime/PgBouncer URL.
EOF
}

database_url="${CHALK_DATABASE_URL:-$(./scripts/dev-postgres.sh url)}"
command="${1:-status}"
shift || true

case "${command}" in
  describe | help | -h | --help)
    describe
    exit 0
    ;;
esac

go tool goose -dir db/migrations postgres "${database_url}" "${command}" "$@"
