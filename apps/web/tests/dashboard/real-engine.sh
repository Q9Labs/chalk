#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
if [[ "${CHALK_GATE_POSTGRES_READY:-0}" != 1 ]]; then
  exec bash scripts/gates/with-postgres.sh -- bash apps/web/tests/dashboard/real-engine.sh "$@"
fi
deadline_seconds="${DASHBOARD_ENGINE_DEADLINE_SECONDS:-240}"
if [[ ! "$deadline_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "DASHBOARD_ENGINE_DEADLINE_SECONDS must be a positive integer" >&2
  exit 2
fi
mkdir -p artifacts
export CHALK_API_ENV=local
# The suite drives one service principal far past the per-account production budget.
if [[ "${DASHBOARD_REFRESH_COST:-0}" == 1 ]]; then
  export CHALK_API_RATE_LIMITS=on
else
  export CHALK_API_RATE_LIMITS="${CHALK_API_RATE_LIMITS:-off}"
fi
export CHALK_API_ADDR=127.0.0.1:18080
export CHALK_API_CORS_ALLOWED_ORIGINS=http://127.0.0.1:18797
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
export CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID=00000000-0000-4000-8000-000000000001
export CHALK_PUBLIC_INVITE_DEFAULT_MEDIA_PLANE=cf_sfu
export CHALK_PUBLIC_INVITE_WEB_ORIGIN=http://127.0.0.1:18080
export CHALK_PUBLIC_INVITE_KEY_ID=dashboard-proof
export CHALK_PUBLIC_INVITE_PRIVATE_KEY="$CHALK_SYNC_TOKEN_PRIVATE_KEY"
CHALK_PUBLIC_INVITE_VERIFICATION_KEYS="$(node --input-type=module -e 'process.stdout.write(JSON.stringify({"dashboard-proof":Buffer.from(process.env.CHALK_SYNC_TOKEN_PRIVATE_KEY,"base64url").subarray(32).toString("base64url")}))')"
export CHALK_PUBLIC_INVITE_VERIFICATION_KEYS
export CHALK_DEFAULT_MEDIA_PLANE=cf_sfu
export CHALK_CLOUDFLARE_REALTIME_APP_ID=dashboard-proof
export CHALK_CLOUDFLARE_REALTIME_APP_SECRET=fixture-cloudflare-not-a-secret
export CHALK_CLOUDFLARE_REALTIME_BASE_URL=http://127.0.0.1:18081
# Enable the real historical-artifact routes without contacting vendor services.
export CHALK_RECORDING_ENABLED=true
export CHALK_TRANSCRIPTION_ENABLED=true
export CHALK_R2_BUCKET=dashboard-proof
export CHALK_R2_ENDPOINT=http://127.0.0.1:18081
export CHALK_R2_ACCESS_KEY_ID=fixture-r2-key
export CHALK_R2_SECRET_ACCESS_KEY=fixture-r2-not-a-secret
export CHALK_RECORDING_KMS_KEY_ID=alias/dashboard-proof
export CHALK_RECORDING_KMS_REGION=us-east-1
export CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET=fixture-transcription-auth-secret-at-least-32-bytes
export CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME=dashboard-proof
export AWS_ACCESS_KEY_ID=fixture-aws-key
export AWS_SECRET_ACCESS_KEY=fixture-aws-not-a-secret
export AWS_EC2_METADATA_DISABLED=true
export AWS_ENDPOINT_URL=http://127.0.0.1:18081
export GOFLAGS=-buildvcs=false
if [[ "${DASHBOARD_REFRESH_COST:-0}" == 1 ]]; then
  pnpm exec turbo run build --filter=web...
fi
(cd apps/api && go build -o ../../artifacts/dashboard-api ./cmd)
final_pid=""
api_pid=""
vendor_pid=""
watchdog_pid=""
redis_container=""
certificate_dir=""
cleanup() {
  [[ -z "$final_pid" ]] || kill "$final_pid" 2>/dev/null || true
  [[ -z "$final_pid" ]] || wait "$final_pid" 2>/dev/null || true
  [[ -z "$vendor_pid" ]] || kill "$vendor_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || kill "$api_pid" 2>/dev/null || true
  [[ -z "$watchdog_pid" ]] || kill "$watchdog_pid" 2>/dev/null || true
  [[ -z "$vendor_pid" ]] || wait "$vendor_pid" 2>/dev/null || true
  [[ -z "$api_pid" ]] || wait "$api_pid" 2>/dev/null || true
  [[ -z "$redis_container" ]] || docker stop --time 1 "$redis_container" >/dev/null 2>&1 || true
  if [[ -n "$certificate_dir" ]]; then
    rm -f "$certificate_dir"/{ca.key,ca.pem,ca.srl,server.key,server.csr,server.pem,server.ext,sync.key,sync.csr,sync.pem,sync.ext}
    rmdir "$certificate_dir"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
certificate_dir="$(mktemp -d /tmp/dashboard-capability-identity.XXXXXX)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=dashboard-proof-ca \
  -addext basicConstraints=critical,CA:TRUE \
  -keyout "$certificate_dir/ca.key" -out "$certificate_dir/ca.pem" > artifacts/dashboard-certificates.log 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=localhost \
  -keyout "$certificate_dir/server.key" -out "$certificate_dir/server.csr" >> artifacts/dashboard-certificates.log 2>&1
cat > "$certificate_dir/server.ext" <<'CERT'
subjectAltName=DNS:localhost,IP:127.0.0.1,URI:spiffe://chalk.local/api
extendedKeyUsage=serverAuth
CERT
openssl x509 -req -in "$certificate_dir/server.csr" -CA "$certificate_dir/ca.pem" \
  -CAkey "$certificate_dir/ca.key" -CAcreateserial -days 1 \
  -extfile "$certificate_dir/server.ext" -out "$certificate_dir/server.pem" >> artifacts/dashboard-certificates.log 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=dashboard-proof-sync \
  -keyout "$certificate_dir/sync.key" -out "$certificate_dir/sync.csr" >> artifacts/dashboard-certificates.log 2>&1
cat > "$certificate_dir/sync.ext" <<'CERT'
subjectAltName=URI:spiffe://chalk.local/environment/local/sync/00000000-0000-4000-8000-000000000002
extendedKeyUsage=clientAuth
CERT
openssl x509 -req -in "$certificate_dir/sync.csr" -CA "$certificate_dir/ca.pem" \
  -CAkey "$certificate_dir/ca.key" -CAcreateserial -days 1 \
  -extfile "$certificate_dir/sync.ext" -out "$certificate_dir/sync.pem" >> artifacts/dashboard-certificates.log 2>&1
export CHALK_PROVIDER_BRIDGE_ADDRESS=127.0.0.1:18444
export CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE="$certificate_dir/server.pem"
export CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE="$certificate_dir/server.key"
export CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE="$certificate_dir/ca.pem"
export CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN=chalk.local
export CHALK_SYNC_PROVIDER_BRIDGE_URL=https://localhost:18444
export CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE="$certificate_dir/sync.pem"
export CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE="$certificate_dir/sync.key"
export CHALK_SYNC_PROVIDER_BRIDGE_CAFILE="$certificate_dir/ca.pem"
redis_container="$(docker run -d --rm -p 127.0.0.1::6379 redis:8.10.0-alpine redis-server --save '' --appendonly no)"
export CHALK_REDIS_URL="redis://$(docker port "$redis_container" 6379/tcp)/0"
for attempt in {1..50}; do
  if docker exec "$redis_container" redis-cli ping >/dev/null 2>&1; then break; fi
  sleep 0.1
done
docker exec "$redis_container" redis-cli ping >/dev/null
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
python3 - "$BASHPID" "$api_pid" "$redis_container" "$deadline_seconds" <<'PY' &
import os, signal, subprocess, sys, time
owner, child = map(int, sys.argv[1:3])
for _ in range(int(sys.argv[4])):
    try: os.kill(owner, 0)
    except ProcessLookupError: break
    time.sleep(1)
try: os.kill(owner, signal.SIGTERM)
except ProcessLookupError: pass
try: os.kill(child, signal.SIGTERM)
except ProcessLookupError: pass
subprocess.run(["docker", "stop", "--time", "1", sys.argv[3]], timeout=15, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
PY
watchdog_pid=$!
for attempt in {1..100}; do
  if curl --fail --silent "$DASHBOARD_TEST_API_ORIGIN/healthz" >/dev/null; then break; fi
  if ! kill -0 "$api_pid" 2>/dev/null; then cat artifacts/dashboard-api.log; exit 1; fi
  sleep 0.1
done
if (($# == 0)); then
  pnpm --filter web run test:dashboard
else
  "$@" &
  final_pid=$!
  wait "$final_pid"
fi
