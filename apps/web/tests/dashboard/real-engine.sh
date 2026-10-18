#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != 1 ]]; then
  exec bash scripts/gates/with-postgres.sh -- bash apps/web/tests/dashboard/real-engine.sh
fi
mkdir -p artifacts
export CHALK_API_ENV=local
export CHALK_API_ADDR=127.0.0.1:18080
export CHALK_API_LOCAL_SYSTEM_TOKEN=fixture-local-system-not-a-secret
export CHALK_API_SERVICE_ID=dashboard-runtime-proof
export CHALK_API_SERVICE_SECRETS=fixture-dashboard-service-token-not-a-secret
export CHALK_API_SERVICE_SCOPES=tenants:read,tenants:write,spaces:read,spaces:write,episodes:read,episodes:write,recordings:read,recordings:write,transcriptions:read,transcriptions:write,transcriptions:delete,api_keys:read,api_keys:write,api_keys:delete,webhooks:read,webhooks:write,webhooks:delete
export DASHBOARD_TEST_API_ORIGIN=http://127.0.0.1:18080
export CHALK_SYNC_TOKEN_ISSUER=dashboard-proof
export CHALK_SYNC_TOKEN_AUDIENCE=chalk-sync
export CHALK_SYNC_TOKEN_KEY_ID=dashboard-proof
# Ephemeral local-only signing material: Go's Ed25519 private format is seed+public.
CHALK_SYNC_TOKEN_PRIVATE_KEY="$(node --input-type=module -e 'import {generateKeyPairSync} from "node:crypto"; const {privateKey}=generateKeyPairSync("ed25519"); const key=privateKey.export({format:"jwk"}); process.stdout.write(Buffer.concat([Buffer.from(key.d,"base64url"),Buffer.from(key.x,"base64url")]).toString("base64url"))')"
export CHALK_SYNC_TOKEN_PRIVATE_KEY
export CHALK_CLOUDFLARE_REALTIME_APP_ID=dashboard-proof
export CHALK_CLOUDFLARE_REALTIME_APP_SECRET=fixture-cloudflare-not-a-secret
export CHALK_CLOUDFLARE_REALTIME_BASE_URL=http://127.0.0.1:18081
export GOFLAGS=-buildvcs=false
(cd apps/api && go build -o ../../artifacts/dashboard-api ./cmd)
api_pid=""
vendor_pid=""
watchdog_pid=""
cleanup() {
  [[ -z "$vendor_pid" ]] || kill "$vendor_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  [[ -z "$watchdog_pid" ]] || kill "$watchdog_pid" 2>/dev/null || true
  [[ -z "$vendor_pid" ]] || wait "$vendor_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || wait "$api_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
node apps/web/tests/dashboard/vendor-fixture.mjs "$BASHPID" > artifacts/dashboard-vendor.log 2>&1 &
vendor_pid=$!
for attempt in {1..50}; do
  if curl --fail --silent "$CHALK_CLOUDFLARE_REALTIME_BASE_URL/healthz" >/dev/null; then break; fi
  if ! kill -0 "$vendor_pid" 2>/dev/null; then cat artifacts/dashboard-vendor.log; exit 1; fi
  sleep 0.1
done
kill -0 "$vendor_pid"
artifacts/dashboard-api > artifacts/dashboard-api.log 2>&1 &
api_pid=$!
# Owner loss and a hard deadline also reap the server if the driver is killed.
python3 - "$BASHPID" "$api_pid" <<'PY' &
import os, signal, sys, time
owner, child = map(int, sys.argv[1:])
for _ in range(240):
    try: os.kill(owner, 0)
    except ProcessLookupError: break
    time.sleep(1)
try: os.kill(child, signal.SIGTERM)
except ProcessLookupError: pass
PY
watchdog_pid=$!
for attempt in {1..100}; do
  if curl --fail --silent "$DASHBOARD_TEST_API_ORIGIN/healthz" >/dev/null; then break; fi
  if ! kill -0 "$api_pid" 2>/dev/null; then cat artifacts/dashboard-api.log; exit 1; fi
  sleep 0.1
done
pnpm --filter web run test:dashboard
