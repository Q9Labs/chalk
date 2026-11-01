#!/usr/bin/env bash
# Run on disposable Linux (Instabox). All listeners remain loopback-only.
set -euo pipefail
cd "$(dirname "$0")/../../.."
state="$PWD/.private/mcp-eval-stack"
mkdir -p "$state"
chmod 700 "$state"
container="chalk-mcp-eval-postgres-$$"
redis_container="chalk-mcp-eval-redis-$$"
api_pid=""
cleanup() {
  if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker rm -f "$redis_container" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export CHALK_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:25432/chalk_mcp_eval?sslmode=disable'
export CHALK_API_ADDR=127.0.0.1:18080 CHALK_API_ENV=local CHALK_API_RATE_LIMITS=off
export CHALK_API_LOG_FORMAT=json CHALK_API_LOG_LEVEL=info
export CHALK_RECORDING_ENABLED=true CHALK_TRANSCRIPTION_ENABLED=true
# Enable read-side application ports without ever reaching a real provider.
export CHALK_R2_ENDPOINT=http://127.0.0.1:9 CHALK_R2_BUCKET=mcp-eval
export CHALK_R2_ACCESS_KEY_ID=local-fixture CHALK_R2_SECRET_ACCESS_KEY=local-fixture
export CHALK_RECORDING_KMS_KEY_ID=local-fixture CHALK_RECORDING_KMS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=local-fixture AWS_SECRET_ACCESS_KEY=local-fixture
export AWS_ENDPOINT_URL=http://127.0.0.1:9 AWS_EC2_METADATA_DISABLED=true
export CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET=local-fixture-not-for-production-0000
export CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION=local-fixture
export CHALK_CLOUDFLARE_ACCOUNT_ID=local-fixture CHALK_CLOUDFLARE_REALTIME_APP_ID=local-fixture
export CHALK_CLOUDFLARE_REALTIME_APP_SECRET=local-fixture CHALK_CLOUDFLARE_REALTIME_BASE_URL=http://127.0.0.1:9
export CHALK_REDIS_URL=redis://127.0.0.1:26379/0
docker run --name "$redis_container" -p 127.0.0.1:26379:6379 -d redis:7-alpine >/dev/null
docker run --name "$container" -e POSTGRES_DB=chalk_mcp_eval -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:25432:5432 -d postgres:18.3-alpine >/dev/null
for _ in {1..60}; do
  if docker exec "$container" sh -c 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres -d chalk_mcp_eval' >/dev/null 2>&1; then break; fi
  sleep 0.5
done
apps/api/scripts/db-migrate.sh up > "$state/migrations.log" 2>&1
psql "$CHALK_DATABASE_URL" -X -v ON_ERROR_STOP=1 -qc 'create table mcp_eval_marker (id boolean primary key check(id)); insert into mcp_eval_marker values(true);'
(cd apps/api && GOMAXPROCS=2 go build -o "$state/api" ./cmd) > "$state/build.log" 2>&1
"$state/api" > "$state/api.jsonl" 2>&1 &
api_pid=$!
for _ in {1..60}; do
  if curl -fsS http://127.0.0.1:18080/healthz >/dev/null; then
    printf 'MCP eval ready: API 18080, Postgres 25432; log %s/api.jsonl\n' "$state"
    wait "$api_pid"
    exit $?
  fi
  if ! kill -0 "$api_pid" 2>/dev/null; then tail -20 "$state/api.jsonl"; exit 1; fi
  sleep 1
done
echo 'API readiness timed out' >&2
exit 1
