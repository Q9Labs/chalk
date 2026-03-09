#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_DATA_DIR="${PG_DATA_DIR:-$HOME/chalk-postgres-data}"
PG_USER="${PG_USER:-postgres}"
PG_PASSWORD="${PG_PASSWORD:-hello123}"
PG_DB="${PG_DB:-chalk}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PG_SSLMODE="${PG_SSLMODE:-disable}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
API_PORT="${API_PORT:-8080}"
export PGHOST="${PG_HOST}"
export PGPORT="${PG_PORT}"

log() { printf '%s %s\n' "[$(date '+%Y-%m-%dT%H:%M:%S%z')]" "$*"; }
fail() { log "ERROR: $*"; exit 1; }

command -v psql >/dev/null || fail "psql not found. Install PostgreSQL client tools."
command -v initdb >/dev/null || fail "initdb not found. Install PostgreSQL server binaries."
command -v pg_ctl >/dev/null || fail "pg_ctl not found. Install PostgreSQL server binaries."
command -v redis-server >/dev/null || fail "redis-server not found. Install Redis."
command -v go >/dev/null || fail "Go not found. Install Go."

if [ ! -d "$PG_DATA_DIR" ]; then
  log "Initializing Postgres data dir: $PG_DATA_DIR"
  initdb -D "$PG_DATA_DIR" -U "$PG_USER" -A password --pwfile=<(printf '%s' "$PG_PASSWORD")
else
  log "Using existing Postgres data dir: $PG_DATA_DIR"
fi

if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
  log "Starting Postgres on ${PG_HOST}:${PG_PORT}"
  pg_ctl -D "$PG_DATA_DIR" -l "$PG_DATA_DIR/postgres.log" -o "-F -h ${PG_HOST} -p ${PG_PORT}" start
else
  log "Postgres already accepting connections"
fi

if ! pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
  fail "Postgres did not become ready"
fi

if ! command -v redis-cli >/dev/null; then
  fail "redis-cli not found."
fi

if ! redis-cli ping >/dev/null 2>&1; then
  log "Starting Redis on localhost:6379"
  redis-server --daemonize yes --port 6379
  for i in {1..20}; do
    if redis-cli ping >/dev/null 2>&1; then
      log "Redis is ready"
      break
    fi
    sleep 0.2
  done
fi
if ! redis-cli ping >/dev/null 2>&1; then
  fail "Redis did not become ready"
fi

log "Ensuring database exists: $PG_DB"
export PGPASSWORD="$PG_PASSWORD"
if [ -z "$(psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}';")" ]; then
  psql -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE ${PG_DB};"
  log "Created database ${PG_DB}"
else
  log "Database ${PG_DB} already exists"
fi

ENV_FILE="$PROJECT_ROOT/chalk-api.local.env"
cat > "$ENV_FILE" <<EOF
DATABASE_URL=postgres://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT}/${PG_DB}?sslmode=${PG_SSLMODE}
DATABASE_NAME=${PG_DB}
DATABASE_USER=${PG_USER}
DATABASE_PASSWORD=${PG_PASSWORD}
DATABASE_HOST=${PG_HOST}
DATABASE_PORT=${PG_PORT}
DATABASE_SSLMODE=${PG_SSLMODE}
REDIS_URL=${REDIS_URL}
CLOUDFLARE_MOCK=true
EOF

log "Launching API on port ${API_PORT}"
cd "$PROJECT_ROOT/apps/api"
set -a
. "$ENV_FILE"
export PORT="${API_PORT}"
set +a
go run ./cmd/main.go
