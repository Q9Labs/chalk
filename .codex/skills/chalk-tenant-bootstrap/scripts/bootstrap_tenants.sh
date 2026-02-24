#!/usr/bin/env bash
set -euo pipefail

API_BASE="${CHALK_API_BASE_URL:-https://chalk-api.q9labs.ai}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="/tmp/chalk_tenants_recreate_${STAMP}.jsonl"

create_tenant() {
  local name="$1"
  local webhook_url="$2"
  local allowed_origin="$3"

  local create_payload
  create_payload=$(jq -n --arg name "$name" '{name:$name,max_concurrent_rooms:150,max_participants_per_room:20,max_recording_duration_minutes:180}')

  local create_resp
  create_resp=$(curl -sS -X POST "$API_BASE/api/v1/tenants" \
    -H 'Content-Type: application/json' \
    --data "$create_payload")

  local tenant_id api_key
  tenant_id=$(printf '%s' "$create_resp" | jq -r '.tenant.id')
  api_key=$(printf '%s' "$create_resp" | jq -r '.api_key')

  if [[ -z "$tenant_id" || "$tenant_id" == "null" || -z "$api_key" || "$api_key" == "null" ]]; then
    echo "FAILED_CREATE name=$name body=$create_resp" >&2
    return 1
  fi

  local whsec
  whsec="whsec_$(openssl rand -hex 24)"

  local cfg_payload
  cfg_payload=$(jq -n \
    --arg allowed_origin "$allowed_origin" \
    --arg webhook_url "$webhook_url" \
    --arg whsec "$whsec" \
    '{
      force_recording:true,
      auto_start_recording:true,
      allow_early_join:true,
      transcription_enabled:true,
      transcription_language:"en-US",
      allowed_origins:[$allowed_origin],
      post_meeting_webhook:{
        enabled:true,
        url:$webhook_url,
        secret:$whsec,
        include_recording:true,
        include_transcript:true,
        include_summary:true,
        include_action_items:true,
        transcription:{provider:"whisper"},
        ai:{provider:"openrouter"}
      }
    }')

  local cfg_http
  cfg_http=$(curl -sS -o /tmp/chalk_cfg_resp.json -w '%{http_code}' \
    -X PATCH "$API_BASE/api/v1/tenants/$tenant_id/config" \
    -H "X-API-Key: $api_key" \
    -H 'Content-Type: application/json' \
    --data "$cfg_payload")

  if [[ "$cfg_http" != "200" ]]; then
    echo "FAILED_CONFIG name=$name tenant_id=$tenant_id http=$cfg_http body=$(cat /tmp/chalk_cfg_resp.json)" >&2
    return 1
  fi

  jq -n \
    --arg name "$name" \
    --arg tenant_id "$tenant_id" \
    --arg api_key "$api_key" \
    --arg webhook_url "$webhook_url" \
    --arg webhook_secret "$whsec" \
    --arg allowed_origin "$allowed_origin" \
    '{name:$name,tenant_id:$tenant_id,api_key:$api_key,webhook_secret:$webhook_secret,allowed_origin:$allowed_origin,webhook_url:$webhook_url}' >> "$OUT"
}

create_tenant 'Tuition Highway' 'https://backend.tuitionhighway.com/webhook/chalk' 'https://portal.tuitionhighway.com'
create_tenant 'Tuition Highway Dev' 'https://backend-dev.tuitionhighway.com/webhook/chalk' 'https://dev.d17jmjn2v13h91.amplifyapp.com'
create_tenant 'Collabdash' 'https://backend.collabdash.io/webhook/chalk' 'https://app.collabdash.io'
create_tenant 'Chalk Web' 'https://chalk-api.q9labs.ai/api/v1/webhooks/local/post-meeting?app=chalk_web' 'https://chalk.q9labs.ai'
create_tenant 'Chalk Mobile' 'https://chalk-api.q9labs.ai/api/v1/webhooks/local/post-meeting?app=chalk_mobile' 'https://chalk.q9labs.ai'
create_tenant 'Eman Time' 'https://backend.emantime.com/webhook/chalk' 'https://app.emantime.com'
create_tenant 'Eman Time Dev' 'https://dev-backend.emantime.com/webhook/chalk' 'https://dev-app.emantime.com'

echo "Created tenants. Artifact: $OUT"
echo
echo "| Name | Tenant ID | API Key | Webhook Secret | Allowed Origin | Webhook URL |"
echo "|---|---|---|---|---|---|"
jq -r '[.name,.tenant_id,.api_key,.webhook_secret,.allowed_origin,.webhook_url] | "| " + join(" | ") + " |"' "$OUT"
