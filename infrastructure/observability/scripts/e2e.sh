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

free_port() {
  node -e 'const server=require("node:net").createServer();server.listen(0,"127.0.0.1",()=>{console.log(server.address().port);server.close()})'
}

api_port="$(free_port)"
sync_port="$(free_port)"
receiver_port="$(free_port)"
database_url="postgres://postgres:postgres@127.0.0.1:55432/${database}?sslmode=disable"
receiver_secret_file="${artifact_dir}/webhook-receiver-secret.json"
receiver_state_file="${artifact_dir}/webhook-receiver-state.json"
receiver_inbox_file="${artifact_dir}/webhook-receiver-inbox.json"
restart_request_file="${artifact_dir}/webhook-restart-request.json"
restart_complete_file="${artifact_dir}/webhook-restart-complete.json"
host_seed_request_file="${artifact_dir}/webhook-host-seed-request.json"
host_seed_complete_file="${artifact_dir}/webhook-host-seed-complete.json"
sync_token_key_file="${artifact_dir}/sync-token-key.json"

cleanup() {
  for pid in "${webhook_proof_pid}" "${tunnel_pid}" "${receiver_pid}"; do
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

start_api() {
  GODEBUG=netdns=go \
  CHALK_API_ADDR="127.0.0.1:${api_port}" \
  CHALK_API_LOCAL_SYSTEM_TOKEN="${system_token}" \
  CHALK_API_OPERATION_LOGS=1 \
  CHALK_API_OTLP_ENDPOINT="http://127.0.0.1:4318" \
  CHALK_API_OTLP_INSECURE=1 \
  CHALK_API_REQUEST_LOGS=all \
  CHALK_DATABASE_URL="${database_url}" \
  CHALK_SYNC_TOKEN_AUDIENCE="${sync_token_audience}" \
  CHALK_SYNC_TOKEN_ISSUER="${sync_token_issuer}" \
  CHALK_SYNC_TOKEN_KEY_ID="${sync_token_key_id}" \
  CHALK_SYNC_TOKEN_PRIVATE_KEY="$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).private_key)' "${sync_token_key_file}")" \
  OTEL_METRIC_EXPORT_INTERVAL=1000 \
    "${artifact_dir}/chalk-api-${timestamp}" >>"${artifact_dir}/api.log" 2>&1 &
  api_pid=$!
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
    session_policy="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "select json_build_object('host_exit_policy', host_exit_policy, 'role_capabilities', role_capabilities, 'deadline_at_ms', floor(extract(epoch from deadline_at) * 1000)::bigint, 'deadline_generation', deadline_generation) from room_sessions where tenant_id = '${tenant_id}'::uuid and room_id = '${room_id}'::uuid and id = '${session_id}'::uuid and status = 'active'")"
    bootstrap_projection="$(
      cd "${root}/apps/sync"
      CHALK_DATABASE_URL="${database_url}" \
      CHALK_E2E_SESSION_ID="${session_id}" \
      CHALK_E2E_SESSION_POLICY_JSON="${session_policy}" \
      CHALK_SYNC_LOCAL_PROOF=true \
      CHALK_SYNC_MAX_WAL_LAG_BYTES=0 \
      CHALK_SYNC_REQUIRED_MIGRATION="${sync_required_migration}" \
      MIX_ENV=prod \
        mix run --no-start --no-compile -e 'policy = JSON.decode!(System.fetch_env!("CHALK_E2E_SESSION_POLICY_JSON")); state = ChalkSync.Sessions.Reducer.new(System.fetch_env!("CHALK_E2E_SESSION_ID"), policy); IO.write(JSON.encode!(%{"digest_hex" => Base.encode16(ChalkSync.Sessions.Reducer.digest(state), case: :lower), "schema_version" => ChalkSync.Sessions.Reducer.state_schema_version(), "snapshot_bytes" => ChalkSync.Sessions.Reducer.snapshot_bytes(state)}))'
    )"
    state_digest="$(node -e 'const value=JSON.parse(process.argv[1]).digest_hex; if (!/^[0-9a-f]{64}$/.test(value)) process.exit(2); process.stdout.write(value)' "${bootstrap_projection}")"
    state_schema_version="$(node -e 'const value=JSON.parse(process.argv[1]).schema_version; if (value !== 3) process.exit(2); process.stdout.write(String(value))' "${bootstrap_projection}")"
    snapshot_bytes="$(node -e 'const value=JSON.parse(process.argv[1]).snapshot_bytes; if (!Number.isSafeInteger(value) || value < 1 || value > 1048576) process.exit(2); process.stdout.write(String(value))' "${bootstrap_projection}")"
    seeded_control_rows="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "with policy as (select host_exit_policy, role_capabilities, floor(extract(epoch from deadline_at) * 1000)::bigint as deadline_at_ms, deadline_generation from room_sessions where tenant_id = '${tenant_id}'::uuid and room_id = '${room_id}'::uuid and id = '${session_id}'::uuid and status = 'active') update sync_session_control as control set folded_state = jsonb_build_object('control_revision', 0, 'state_schema_version', ${state_schema_version}, 'status', 'active', 'admission_policy', 'open', 'host_exit_policy', policy.host_exit_policy, 'host_participant_session_id', null, 'deadline_at_ms', policy.deadline_at_ms, 'deadline_generation', policy.deadline_generation, 'role_capabilities', policy.role_capabilities, 'recording', null, 'admission_requests', jsonb_build_array(), 'participants', jsonb_build_array()), state_schema_version = ${state_schema_version}, state_digest = decode('${state_digest}', 'hex'), snapshot_bytes = ${snapshot_bytes}, updated_at = clock_timestamp() from policy where control.tenant_id = '${tenant_id}'::uuid and control.room_id = '${room_id}'::uuid and control.session_id = '${session_id}'::uuid and control.control_revision = 0 and control.state_schema_version = 1 and control.host_participant_session_id is null and control.folded_state = '{\"control_revision\":0,\"participants\":[],\"state_schema_version\":1,\"status\":\"active\"}'::jsonb returning 1")"
    if [[ "${seeded_control_rows}" != "1" ]]; then
      echo "The disposable E2E v3 control seed updated ${seeded_control_rows:-0} Sessions, want exactly one." >&2
      exit 1
    fi
    seeded_participant_rows="$(docker exec chalk-observability-postgres psql -U postgres -d "${database}" -v ON_ERROR_STOP=1 -qAtc "update participants set role = 'host', eligible_roles = array['host','cohost','participant']::text[], updated_at = clock_timestamp() where tenant_id = '${tenant_id}'::uuid and room_id = '${room_id}'::uuid and session_id = '${session_id}'::uuid and id = '${participant_id}'::uuid and status = 'joining' and role = 'participant' and eligible_roles = array['participant']::text[] returning 1")"
    if [[ "${seeded_participant_rows}" != "1" ]]; then
      echo "The disposable E2E Host seed updated ${seeded_participant_rows:-0} participants, want exactly one." >&2
      exit 1
    fi
    start_sync
    wait_for_sync
    node -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify({ local_seeded_host_role: true, local_seeded_v3_control_policy: true, seeded_at: new Date().toISOString() }) + "\n", { mode: 0o600 })' "${host_seed_complete_file}"
    break
  fi
  if ! kill -0 "${webhook_proof_pid}" >/dev/null 2>&1; then
    wait "${webhook_proof_pid}" || true
    echo "The signed webhook proof exited before requesting the local Host seed." >&2
    cat "${artifact_dir}/webhook-proof.err" >&2 || true
    exit 1
  fi
  sleep 0.25
done
if [[ ! -f "${host_seed_complete_file}" ]]; then
  echo "The signed webhook proof never reached the local Host seed seam." >&2
  exit 1
fi
if ! wait "${webhook_proof_pid}"; then
  webhook_proof_pid=""
  cat "${artifact_dir}/webhook-proof.err" >&2 || true
  exit 1
fi
webhook_proof_pid=""
cat "${artifact_dir}/webhook-proof.json"

CHALK_E2E_API_URL="http://127.0.0.1:${api_port}" \
CHALK_E2E_SYNC_URL="ws://127.0.0.1:${sync_port}/v1/sync" \
CHALK_E2E_SYSTEM_TOKEN="${system_token}" \
  node "${root}/infrastructure/observability/scripts/e2e-journey.mjs"

echo "Private E2E artifacts: ${artifact_dir}"
