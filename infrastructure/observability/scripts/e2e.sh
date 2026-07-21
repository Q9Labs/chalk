#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1 && [[ -x "${HOME}/.orbstack/bin/docker" ]]; then
  export PATH="${HOME}/.orbstack/bin:${PATH}"
fi
if ! command -v go >/dev/null 2>&1 && [[ -x "/usr/local/go/bin/go" ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi

root="$(cd "$(dirname "$0")/../../.." && pwd)"
timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
artifact_suffix="$(node -e 'process.stdout.write(crypto.randomUUID().slice(0, 8))')"
artifact_dir="${root}/.private/observability-e2e-${timestamp}-${BASHPID}-${artifact_suffix}"
database="chalk_observability"
system_token="chalk-observability-local-e2e"
sync_token_audience="chalk-sync-local-e2e"
sync_token_issuer="https://api.chalk.local"
sync_token_key_id="local-e2e-${artifact_suffix}"
api_pid=""
sync_pid=""
receiver_pid=""
tunnel_pid=""
webhook_proof_pid=""
sfu_stub_pid=""

free_port() {
  node -e 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})'
}

api_port="$(free_port)"
sync_port="$(free_port)"
receiver_port="$(free_port)"
provider_bridge_port="$(free_port)"
sfu_stub_port="$(free_port)"
database_url="postgres://postgres:postgres@127.0.0.1:55432/${database}?sslmode=disable"
receiver_secret_file="${artifact_dir}/webhook-receiver-secret.json"
receiver_state_file="${artifact_dir}/webhook-receiver-state.json"
receiver_inbox_file="${artifact_dir}/webhook-receiver-inbox.json"
restart_request_file="${artifact_dir}/webhook-restart-request.json"
restart_complete_file="${artifact_dir}/webhook-restart-complete.json"
host_seed_request_file="${artifact_dir}/webhook-host-seed-request.json"
host_seed_complete_file="${artifact_dir}/webhook-host-seed-complete.json"
sync_token_key_file="${artifact_dir}/sync-token-key.json"
provider_bridge_trust_domain="chalk.local"
provider_bridge_client_id="$(node -e 'process.stdout.write(crypto.randomUUID())')"
provider_bridge_ca_cert_file="${artifact_dir}/provider-bridge-ca.pem"
provider_bridge_ca_key_file="${artifact_dir}/provider-bridge-ca-key.pem"
provider_bridge_server_cert_file="${artifact_dir}/provider-bridge-server.pem"
provider_bridge_server_key_file="${artifact_dir}/provider-bridge-server-key.pem"
provider_bridge_client_cert_file="${artifact_dir}/provider-bridge-sync.pem"
provider_bridge_client_key_file="${artifact_dir}/provider-bridge-sync-key.pem"
sfu_stub_app_id="local-observability-sfu"
sfu_stub_app_secret="local-observability-sfu-secret-${artifact_suffix}"
sfu_stub_request_log="${artifact_dir}/cloudflare-sfu-requests.jsonl"

cleanup() {
  for pid in "${webhook_proof_pid}" "${tunnel_pid}" "${receiver_pid}" "${sfu_stub_pid}"; do
    if [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1; then
      kill -TERM "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done
  if [[ -n "${api_pid}" ]] && kill -0 "${api_pid}" >/dev/null 2>&1; then
    kill -TERM "${api_pid}" >/dev/null 2>&1 || true
    wait "${api_pid}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${sync_pid}" ]] && kill -0 "${sync_pid}" >/dev/null 2>&1; then
    kill -TERM "${sync_pid}" >/dev/null 2>&1 || true
    wait "${sync_pid}" >/dev/null 2>&1 || true
  fi
  rm -f "${sync_token_key_file}"
}
trap cleanup EXIT

generate_provider_bridge_certificates() {
  local server_extensions="${artifact_dir}/provider-bridge-server-extensions.cnf"
  local client_extensions="${artifact_dir}/provider-bridge-client-extensions.cnf"

  printf '%s\n' \
    '[server]' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature,keyEncipherment' \
    'extendedKeyUsage=serverAuth' \
    'subjectAltName=IP:127.0.0.1,DNS:localhost' >"${server_extensions}"
  printf '%s\n' \
    '[client]' \
    'basicConstraints=critical,CA:FALSE' \
    'keyUsage=critical,digitalSignature' \
    'extendedKeyUsage=clientAuth' \
    "subjectAltName=URI:spiffe://${provider_bridge_trust_domain}/environment/local/sync/${provider_bridge_client_id}" >"${client_extensions}"

  {
    openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 2 \
      -subj '/CN=Chalk local observability provider bridge CA' \
      -addext 'basicConstraints=critical,CA:TRUE' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' \
      -keyout "${provider_bridge_ca_key_file}" \
      -out "${provider_bridge_ca_cert_file}"
    openssl req -newkey rsa:2048 -sha256 -nodes \
      -subj '/CN=localhost' \
      -keyout "${provider_bridge_server_key_file}" \
      -out "${artifact_dir}/provider-bridge-server.csr"
    openssl x509 -req -sha256 -days 1 \
      -in "${artifact_dir}/provider-bridge-server.csr" \
      -CA "${provider_bridge_ca_cert_file}" \
      -CAkey "${provider_bridge_ca_key_file}" \
      -CAcreateserial \
      -extfile "${server_extensions}" \
      -extensions server \
      -out "${provider_bridge_server_cert_file}"
    openssl req -newkey rsa:2048 -sha256 -nodes \
      -subj "/CN=${provider_bridge_client_id}" \
      -keyout "${provider_bridge_client_key_file}" \
      -out "${artifact_dir}/provider-bridge-sync.csr"
    openssl x509 -req -sha256 -days 1 \
      -in "${artifact_dir}/provider-bridge-sync.csr" \
      -CA "${provider_bridge_ca_cert_file}" \
      -CAkey "${provider_bridge_ca_key_file}" \
      -CAcreateserial \
      -extfile "${client_extensions}" \
      -extensions client \
      -out "${provider_bridge_client_cert_file}"
  } >"${artifact_dir}/provider-bridge-certificates.log" 2>&1

  chmod 600 "${provider_bridge_ca_key_file}" "${provider_bridge_server_key_file}" "${provider_bridge_client_key_file}"
}

start_sfu_stub() {
  CHALK_CLOUDFLARE_SFU_STUB_PORT="${sfu_stub_port}" \
  CHALK_CLOUDFLARE_SFU_STUB_APP_ID="${sfu_stub_app_id}" \
  CHALK_CLOUDFLARE_SFU_STUB_APP_SECRET="${sfu_stub_app_secret}" \
  CHALK_CLOUDFLARE_SFU_STUB_REQUEST_LOG="${sfu_stub_request_log}" \
    node "${root}/infrastructure/observability/scripts/cloudflare-sfu-stub.mjs" >"${artifact_dir}/cloudflare-sfu.log" 2>&1 &
  sfu_stub_pid=$!
}

wait_for_sfu_stub() {
  for _ in {1..120}; do
    if curl -fsS "http://127.0.0.1:${sfu_stub_port}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${sfu_stub_pid}" >/dev/null 2>&1; then
      echo "The local Cloudflare SFU stub exited before becoming ready." >&2
      tail -n 100 "${artifact_dir}/cloudflare-sfu.log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "The local Cloudflare SFU stub did not become ready." >&2
  return 1
}

start_api() {
  GODEBUG=netdns=go \
  CHALK_API_ADDR="127.0.0.1:${api_port}" \
  CHALK_API_ENV=local \
  CHALK_API_LOCAL_SYSTEM_TOKEN="${system_token}" \
  CHALK_API_OPERATION_LOGS=1 \
  CHALK_API_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  CHALK_API_OTLP_INSECURE=1 \
  CHALK_API_REQUEST_LOGS=all \
  CHALK_DATABASE_URL="${database_url}" \
  CHALK_CLOUDFLARE_REALTIME_APP_ID="${sfu_stub_app_id}" \
  CHALK_CLOUDFLARE_REALTIME_APP_SECRET="${sfu_stub_app_secret}" \
  CHALK_CLOUDFLARE_REALTIME_BASE_URL="http://127.0.0.1:${sfu_stub_port}/v1" \
  CHALK_PROVIDER_BRIDGE_ADDRESS="127.0.0.1:${provider_bridge_port}" \
  CHALK_PROVIDER_BRIDGE_SERVER_CERT_FILE="${provider_bridge_server_cert_file}" \
  CHALK_PROVIDER_BRIDGE_SERVER_KEY_FILE="${provider_bridge_server_key_file}" \
  CHALK_PROVIDER_BRIDGE_CLIENT_CA_FILE="${provider_bridge_ca_cert_file}" \
  CHALK_PROVIDER_BRIDGE_SPIFFE_TRUST_DOMAIN="${provider_bridge_trust_domain}" \
  CHALK_SYNC_TOKEN_AUDIENCE="${sync_token_audience}" \
  CHALK_SYNC_TOKEN_ISSUER="${sync_token_issuer}" \
  CHALK_SYNC_TOKEN_KEY_ID="${sync_token_key_id}" \
  CHALK_SYNC_TOKEN_PRIVATE_KEY="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).private_key)' "${sync_token_key_file}")" \
  OTEL_METRIC_EXPORT_INTERVAL=1000 \
    "${artifact_dir}/chalk-api-${timestamp}" >>"${artifact_dir}/api.log" 2>&1 &
  api_pid=$!
}

wait_for_provider_bridge() {
  for _ in {1..120}; do
    if curl --fail --silent --show-error \
      --cacert "${provider_bridge_ca_cert_file}" \
      --cert "${provider_bridge_client_cert_file}" \
      --key "${provider_bridge_client_key_file}" \
      "https://127.0.0.1:${provider_bridge_port}/internal/v1/sync/provider-bridge/ready" >/dev/null 2>&1; then
      if curl --fail --silent --show-error \
        --cacert "${provider_bridge_ca_cert_file}" \
        "https://127.0.0.1:${provider_bridge_port}/internal/v1/sync/provider-bridge/ready" >/dev/null 2>&1; then
        echo "The private provider bridge accepted a readiness request without a client certificate." >&2
        return 1
      fi
      return 0
    fi
    if ! kill -0 "${api_pid}" >/dev/null 2>&1; then
      echo "The local API exited before the private provider bridge became ready." >&2
      tail -n 100 "${artifact_dir}/api.log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "The private provider bridge did not become ready with the Sync mTLS identity." >&2
  tail -n 100 "${artifact_dir}/api.log" >&2 || true
  return 1
}

wait_for_api() {
  for _ in {1..120}; do
    if curl -fsS "http://127.0.0.1:${api_port}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${api_pid}" >/dev/null 2>&1; then
      echo "The local API exited before becoming ready." >&2
      tail -n 100 "${artifact_dir}/api.log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "The local API did not become ready." >&2
  return 1
}

start_sync() {
  (
    cd "${root}/apps/sync"
    CHALK_DATABASE_URL="${database_url}" \
    CHALK_SYNC_LOCAL_PROOF=true \
    CHALK_SYNC_MAX_WAL_LAG_BYTES=0 \
    CHALK_SYNC_OTLP_ENDPOINT="http://127.0.0.1:4318" \
    CHALK_SYNC_PORT="${sync_port}" \
    CHALK_SYNC_REQUIRED_MIGRATION="${sync_required_migration}" \
    CHALK_SYNC_TOKEN_AUDIENCE="${sync_token_audience}" \
    CHALK_SYNC_TOKEN_ISSUER="${sync_token_issuer}" \
    CHALK_SYNC_TOKEN_PUBLIC_KEYS="$(node -e 'const key=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).public_key; process.stdout.write(JSON.stringify({[process.argv[2]]:key}))' "${sync_token_key_file}" "${sync_token_key_id}")" \
    CHALK_SYNC_PROVIDER_BRIDGE_URL="https://127.0.0.1:${provider_bridge_port}" \
    CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE="${provider_bridge_client_cert_file}" \
    CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE="${provider_bridge_client_key_file}" \
    CHALK_SYNC_PROVIDER_BRIDGE_CAFILE="${provider_bridge_ca_cert_file}" \
    MIX_ENV=prod \
    PORT="${sync_port}" \
      mix run --no-start -e 'keys = System.fetch_env!("CHALK_SYNC_TOKEN_PUBLIC_KEYS") |> JSON.decode!() |> Map.new(fn {id, key} -> {id, Base.url_decode64!(key, padding: false)} end); Application.put_env(:chalk_sync, :minimum_compatible_sync_migration, String.to_integer(System.fetch_env!("CHALK_SYNC_REQUIRED_MIGRATION"))); Application.put_env(:chalk_sync, :enable_v1, true); Application.put_env(:chalk_sync, :token_verifier, ChalkSync.Auth.JWTTokenVerifier); Application.put_env(:chalk_sync, :token_issuer, System.fetch_env!("CHALK_SYNC_TOKEN_ISSUER")); Application.put_env(:chalk_sync, :token_audience, System.fetch_env!("CHALK_SYNC_TOKEN_AUDIENCE")); Application.put_env(:chalk_sync, :token_public_keys, keys); {:ok, _} = Application.ensure_all_started(:chalk_sync); Process.sleep(:infinity)'
  ) >"${artifact_dir}/sync.log" 2>&1 &
  sync_pid=$!
}

wait_for_sync() {
  for _ in {1..120}; do
    if curl -fsS "http://127.0.0.1:${sync_port}/readyz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "${sync_pid}" >/dev/null 2>&1; then
      echo "The local Sync app exited before becoming ready." >&2
      tail -n 100 "${artifact_dir}/sync.log" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "The local Sync app did not become ready." >&2
  return 1
}

mkdir -p "${artifact_dir}"
node -e 'const { generateKeyPairSync }=require("node:crypto"); const { writeFileSync }=require("node:fs"); const { privateKey, publicKey }=generateKeyPairSync("ed25519"); const privateJWK=privateKey.export({format:"jwk"}); const publicJWK=publicKey.export({format:"jwk"}); const rawPrivate=Buffer.concat([Buffer.from(privateJWK.d,"base64url"),Buffer.from(publicJWK.x,"base64url")]).toString("base64url"); writeFileSync(process.argv[1], JSON.stringify({private_key:rawPrivate,public_key:publicJWK.x})+"\n", {mode:0o600})' "${sync_token_key_file}"
generate_provider_bridge_certificates
start_sfu_stub
wait_for_sfu_stub
bash "${root}/infrastructure/observability/scripts/local.sh" start
docker exec chalk-observability-postgres dropdb -U postgres --force --if-exists "${database}"
docker exec chalk-observability-postgres createdb -U postgres "${database}"

CHALK_DATABASE_URL="${database_url}" bash "${root}/apps/api/scripts/db-migrate.sh" up
sync_required_migration="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -Atc 'select max(version_id) from goose_db_version where is_applied')"
pnpm --dir "${root}/sdks/typescript/client" run build

(
  cd "${root}/apps/sync"
  MIX_ENV=prod mix compile --warnings-as-errors
)

(
  cd "${root}/apps/api"
  go build -o "${artifact_dir}/chalk-api-${timestamp}" ./cmd
)

start_api
wait_for_api
wait_for_provider_bridge

CHALK_WEBHOOK_RECEIVER_PORT="${receiver_port}" \
CHALK_WEBHOOK_RECEIVER_SECRET_FILE="${receiver_secret_file}" \
CHALK_WEBHOOK_RECEIVER_STATE_FILE="${receiver_state_file}" \
CHALK_WEBHOOK_RECEIVER_INBOX_FILE="${receiver_inbox_file}" \
  node "${root}/infrastructure/observability/scripts/webhook-receiver.mjs" >"${artifact_dir}/webhook-receiver.log" 2>&1 &
receiver_pid=$!
for _ in {1..120}; do
  if curl -fsS "http://127.0.0.1:${receiver_port}/readyz" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "${receiver_pid}" >/dev/null 2>&1; then
    echo "The signed webhook receiver exited before becoming ready." >&2
    tail -n 100 "${artifact_dir}/webhook-receiver.log" >&2 || true
    exit 1
  fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:${receiver_port}/readyz" >/dev/null

webhook_url=""
for tunnel_attempt in 1 2 3; do
  echo "cloudflared quick-tunnel attempt ${tunnel_attempt}" >>"${artifact_dir}/cloudflared.log"
  tunnel_log_start=$(($(wc -l <"${artifact_dir}/cloudflared.log") + 1))
  cloudflared tunnel --url "http://127.0.0.1:${receiver_port}" --no-autoupdate >>"${artifact_dir}/cloudflared.log" 2>&1 &
  tunnel_pid=$!
  for _ in {1..120}; do
    webhook_url="$(tail -n +"${tunnel_log_start}" "${artifact_dir}/cloudflared.log" | sed -nE 's#.*(https://[a-z0-9-]{8,}\.trycloudflare\.com).*#\1#p' | tail -n 1)"
    if [[ -n "${webhook_url}" ]] && kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
      break
    fi
    if ! kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
      wait "${tunnel_pid}" >/dev/null 2>&1 || true
      tunnel_pid=""
      break
    fi
    sleep 0.25
  done
  if [[ -n "${webhook_url}" ]] && kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
    webhook_host="${webhook_url#https://}"
    tunnel_ready_deadline=$((SECONDS + 90))
    while ((SECONDS < tunnel_ready_deadline)); do
      webhook_edge_ip="$(dig +short @1.1.1.1 "${webhook_host}" A | sed -nE '/^[0-9]+(\.[0-9]+){3}$/p' | head -n 1)"
      if [[ -n "${webhook_edge_ip}" ]] && \
        curl --connect-timeout 1 --max-time 2 --resolve "${webhook_host}:443:${webhook_edge_ip}" -fsS "${webhook_url}/readyz" >/dev/null 2>&1; then
        break 2
      fi
      if ! kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
        break
      fi
      sleep 0.25
    done
    echo "quick-tunnel attempt ${tunnel_attempt} registered but did not reach receiver readiness" >>"${artifact_dir}/cloudflared.log"
    webhook_url=""
  fi
  if [[ -n "${tunnel_pid}" ]] && kill -0 "${tunnel_pid}" >/dev/null 2>&1; then
    kill -TERM "${tunnel_pid}" >/dev/null 2>&1 || true
    wait "${tunnel_pid}" >/dev/null 2>&1 || true
    tunnel_pid=""
  fi
  sleep 1
done
if [[ -z "${webhook_url}" ]]; then
  echo "The Cloudflare quick tunnel did not publish an HTTPS URL after three attempts." >&2
  tail -n 100 "${artifact_dir}/cloudflared.log" >&2 || true
  exit 1
fi

CHALK_E2E_API_URL="http://127.0.0.1:${api_port}" \
CHALK_E2E_SYNC_URL="ws://127.0.0.1:${sync_port}/v3/sync" \
CHALK_E2E_SYSTEM_TOKEN="${system_token}" \
CHALK_E2E_WEBHOOK_URL="${webhook_url}/webhook" \
CHALK_WEBHOOK_RECEIVER_SECRET_FILE="${receiver_secret_file}" \
CHALK_WEBHOOK_RECEIVER_STATE_FILE="${receiver_state_file}" \
CHALK_E2E_RESTART_REQUEST_FILE="${restart_request_file}" \
CHALK_E2E_RESTART_COMPLETE_FILE="${restart_complete_file}" \
CHALK_E2E_HOST_SEED_REQUEST_FILE="${host_seed_request_file}" \
CHALK_E2E_HOST_SEED_COMPLETE_FILE="${host_seed_complete_file}" \
  node "${root}/infrastructure/observability/scripts/e2e-webhook.mjs" >"${artifact_dir}/webhook-proof.json" 2>"${artifact_dir}/webhook-proof.err" &
webhook_proof_pid=$!

for _ in {1..180}; do
  if [[ -f "${restart_request_file}" ]]; then
    kill -TERM "${api_pid}" >/dev/null 2>&1
    wait "${api_pid}" >/dev/null 2>&1 || true
    api_pid=""
    start_api
    wait_for_api
    wait_for_provider_bridge
    node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ restarted_at: new Date().toISOString() }) + "\n", { mode: 0o600 })' "${restart_complete_file}"
    break
  fi
  if ! kill -0 "${webhook_proof_pid}" >/dev/null 2>&1; then
    wait "${webhook_proof_pid}" || true
    echo "The signed webhook proof exited before requesting dispatcher restart." >&2
    cat "${artifact_dir}/webhook-proof.err" >&2 || true
    exit 1
  fi
  sleep 0.25
done
if [[ ! -f "${restart_complete_file}" ]]; then
  echo "The signed webhook proof never reached the durable retry state." >&2
  exit 1
fi

for _ in {1..240}; do
  if [[ -f "${host_seed_request_file}" ]]; then
    tenant_id="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).tenant_id; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) process.exit(2); process.stdout.write(value)' "${host_seed_request_file}")"
    room_id="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).room_id; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) process.exit(2); process.stdout.write(value)' "${host_seed_request_file}")"
    session_id="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).session_id; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) process.exit(2); process.stdout.write(value)' "${host_seed_request_file}")"
    participant_id="$(node -e 'const value=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).participant_session_id; if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) process.exit(2); process.stdout.write(value)' "${host_seed_request_file}")"
    verified_control_rows="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "select count(*) from room_sessions as session join sync_session_control as control on control.tenant_id = session.tenant_id and control.room_id = session.room_id and control.session_id = session.id where session.tenant_id = '${tenant_id}'::uuid and session.room_id = '${room_id}'::uuid and session.id = '${session_id}'::uuid and session.status = 'active' and session.host_exit_policy = 'require_transfer' and control.control_revision = 0 and control.state_schema_version = 3 and control.host_participant_session_id is null and control.snapshot_bytes > 0 and octet_length(control.state_digest) = 32 and control.folded_state @> jsonb_build_object('control_revision', 0, 'state_schema_version', 3, 'status', 'active', 'admission_policy', 'open', 'host_exit_policy', session.host_exit_policy, 'role_capabilities', session.role_capabilities, 'participants', jsonb_build_array())")"
    if [[ "${verified_control_rows}" != "1" ]]; then
      echo "The public API created ${verified_control_rows:-0} valid schema-v3 Session control projections, want exactly one." >&2
      exit 1
    fi
    verified_participant_rows="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "select count(*) from participants where tenant_id = '${tenant_id}'::uuid and room_id = '${room_id}'::uuid and session_id = '${session_id}'::uuid and id = '${participant_id}'::uuid and status = 'joining' and role = 'host' and eligible_roles = array['host','cohost','participant']::text[]")"
    if [[ "${verified_participant_rows}" != "1" ]]; then
      echo "The public API created ${verified_participant_rows:-0} valid Host participants, want exactly one." >&2
      exit 1
    fi
    start_sync
    wait_for_sync
    node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ api_created_host_role: true, api_created_v3_control_policy: true, verified_at: new Date().toISOString() }) + "\n", { mode: 0o600 })' "${host_seed_complete_file}"
    break
  fi
  if ! kill -0 "${webhook_proof_pid}" >/dev/null 2>&1; then
    wait "${webhook_proof_pid}" || true
    echo "The signed webhook proof exited before requesting public Session bootstrap verification." >&2
    cat "${artifact_dir}/webhook-proof.err" >&2 || true
    exit 1
  fi
  sleep 0.25
done
if [[ ! -f "${host_seed_complete_file}" ]]; then
  echo "The signed webhook proof never reached public Session bootstrap verification." >&2
  exit 1
fi
if ! wait "${webhook_proof_pid}"; then
  webhook_proof_pid=""
  cat "${artifact_dir}/webhook-proof.err" >&2 || true
  exit 1
fi
webhook_proof_pid=""
cat "${artifact_dir}/webhook-proof.json"

provider_bridge_receipts="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "select coalesce(json_agg(json_build_object('operation_id', operation_id, 'effect', effect, 'state', state, 'outcome', outcome) order by effect), '[]'::json)::text from provider_operation_receipts where tenant_id = '${tenant_id}'::uuid and session_id = '${session_id}'::uuid and effect in ('media.remove_participant', 'media.end_session')")"
node -e '
const receipts = JSON.parse(process.argv[1]);
const expected = new Set(["media.remove_participant", "media.end_session"]);
if (receipts.length !== expected.size) throw new Error(`provider bridge receipt count = ${receipts.length}, want ${expected.size}`);
for (const receipt of receipts) {
  if (!expected.delete(receipt.effect)) throw new Error(`unexpected provider bridge receipt: ${JSON.stringify(receipt)}`);
  if (receipt.state !== "completed" || !["confirmed", "satisfied"].includes(receipt.outcome)) {
    throw new Error(`provider bridge receipt is not terminal success: ${JSON.stringify(receipt)}`);
  }
}
' "${provider_bridge_receipts}"

provider_bridge_trace_ids="$(node -e '
const { readFileSync } = require("node:fs");
const traces = new Set();
for (const line of readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!line.startsWith("{")) continue;
  const entry = JSON.parse(line);
  if (entry.method !== "POST" || entry.status !== 200 || !String(entry.path).startsWith("/internal/v1/sync/provider-operations/")) continue;
  if (!/^[0-9a-f]{32}$/.test(entry.trace_id)) throw new Error(`invalid provider bridge trace ID: ${entry.trace_id}`);
  traces.add(entry.trace_id);
}
if (traces.size !== 2) throw new Error(`provider bridge trace count = ${traces.size}, want 2`);
process.stdout.write([...traces].join(" "));
' "${artifact_dir}/api.log")"
for provider_bridge_trace_id in ${provider_bridge_trace_ids}; do
  provider_bridge_trace="$(curl -fsS "http://127.0.0.1:3200/api/traces/${provider_bridge_trace_id}")"
  if [[ "${provider_bridge_trace}" != *'chalk-api'* || "${provider_bridge_trace}" != *'chalk-sync'* || "${provider_bridge_trace}" != *'provider_bridge.execute'* ]]; then
    echo "Provider bridge trace ${provider_bridge_trace_id} did not contain the API, Sync, and execution spans." >&2
    exit 1
  fi
done
node -e 'console.log(JSON.stringify({ provider_bridge_mtls: true, provider_bridge_cross_service_traces: process.argv[2].split(" "), provider_bridge_receipts: JSON.parse(process.argv[1]) }, null, 2))' "${provider_bridge_receipts}" "${provider_bridge_trace_ids}"

echo "Private E2E artifacts: ${artifact_dir}"
