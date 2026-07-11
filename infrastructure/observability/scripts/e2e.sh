#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
artifact_dir="${root}/.private/observability-e2e-${timestamp}"
database="chalk_observability"
system_token="chalk-observability-local-e2e"
api_pid=""
sync_pid=""

free_port() {
  node -e 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})'
}

api_port="$(free_port)"
sync_port="$(free_port)"
database_url="postgres://postgres:postgres@127.0.0.1:55432/${database}?sslmode=disable"

cleanup() {
  if [[ -n "${api_pid}" ]] && kill -0 "${api_pid}" >/dev/null 2>&1; then
    kill -TERM "${api_pid}" >/dev/null 2>&1 || true
    wait "${api_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${sync_pid}" ]] && kill -0 "${sync_pid}" >/dev/null 2>&1; then
    kill -TERM "${sync_pid}" >/dev/null 2>&1 || true
    wait "${sync_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

mkdir -p "${artifact_dir}"
bash "${root}/infrastructure/observability/scripts/local.sh" start
docker exec chalk-observability-postgres dropdb -U postgres --force --if-exists "${database}"
docker exec chalk-observability-postgres createdb -U postgres "${database}"

CHALK_DATABASE_URL="${database_url}" bash "${root}/apps/api/scripts/db-migrate.sh" up
pnpm --dir "${root}/sdks/typescript/client" run build

(
  cd "${root}/apps/api"
  go build -o "${artifact_dir}/chalk-api-${timestamp}" ./cmd
)

CHALK_API_ADDR="127.0.0.1:${api_port}" \
CHALK_API_LOCAL_SYSTEM_TOKEN="${system_token}" \
CHALK_API_OPERATION_LOGS=1 \
CHALK_API_OTLP_ENDPOINT="http://127.0.0.1:4318" \
CHALK_API_OTLP_INSECURE=1 \
CHALK_API_REQUEST_LOGS=all \
CHALK_DATABASE_URL="${database_url}" \
OTEL_METRIC_EXPORT_INTERVAL=1000 \
  "${artifact_dir}/chalk-api-${timestamp}" >"${artifact_dir}/api.log" 2>&1 &
api_pid=$!

(
  cd "${root}/apps/sync"
  CHALK_SYNC_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  CHALK_SYNC_PORT="${sync_port}" \
    mix run --no-halt
) >"${artifact_dir}/sync.log" 2>&1 &
sync_pid=$!

for _ in {1..120}; do
  if curl -fsS "http://127.0.0.1:${api_port}/readyz" >/dev/null 2>&1 && \
    curl -fsS "http://127.0.0.1:${sync_port}/readyz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${api_pid}" >/dev/null 2>&1 || ! kill -0 "${sync_pid}" >/dev/null 2>&1; then
    echo "A local service exited before becoming ready." >&2
    tail -n 100 "${artifact_dir}/api.log" >&2 || true
    tail -n 100 "${artifact_dir}/sync.log" >&2 || true
    exit 1
  fi
  sleep 0.25
done

curl -fsS "http://127.0.0.1:${api_port}/readyz" >/dev/null
curl -fsS "http://127.0.0.1:${sync_port}/readyz" >/dev/null

CHALK_E2E_API_URL="http://127.0.0.1:${api_port}" \
CHALK_E2E_SYNC_URL="ws://127.0.0.1:${sync_port}/v1/sync" \
CHALK_E2E_SYSTEM_TOKEN="${system_token}" \
  node "${root}/infrastructure/observability/scripts/e2e-journey.mjs"
