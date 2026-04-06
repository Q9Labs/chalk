#!/usr/bin/env bash
set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-q9labs}"
AWS_REGION_NAME="${AWS_REGION_NAME:-us-east-1}"
INSTANCE_ID="${INSTANCE_ID:-i-0a61ed0f5821fb4b1}"
AUDIO_URL="${AUDIO_URL:?AUDIO_URL is required}"
CALLBACK_URL="${CALLBACK_URL:?CALLBACK_URL is required}"
TRANSCRIPT_ID="${TRANSCRIPT_ID:-11111111-1111-1111-1111-111111111111}"
RECORDING_ID="${RECORDING_ID:-22222222-2222-2222-2222-222222222222}"
ROOM_ID="${ROOM_ID:-33333333-3333-3333-3333-333333333333}"

read -r -d '' REMOTE_SCRIPT <<EOF || true
set -euo pipefail
DISPATCH_SECRET=\$(grep '^POST_MEETING_CLOUDFLARE_WORKER_DISPATCH_SECRET=' /etc/chalk/api.env | sed 's/^[^=]*=//')
WORKER_URL=\$(grep '^POST_MEETING_CLOUDFLARE_WORKER_URL=' /etc/chalk/api.env | sed 's/^[^=]*=//')
TIMESTAMP=\$(date +%s)
BODY=\$(jq -nc \
  --arg transcript_id "$TRANSCRIPT_ID" \
  --arg recording_id "$RECORDING_ID" \
  --arg room_id "$ROOM_ID" \
  --arg audio_url "$AUDIO_URL" \
  --arg callback_url "$CALLBACK_URL" \
  '{transcript_id:\$transcript_id,recording_id:\$recording_id,room_id:\$room_id,audio_url:\$audio_url,callback_url:\$callback_url,provider_model:"@cf/openai/whisper-large-v3-turbo"}')
SIGNATURE_HEX=\$(printf '%s' "\$TIMESTAMP.\$BODY" | openssl dgst -sha256 -hmac "\$DISPATCH_SECRET" -hex | awk '{print \$NF}')
SIGNATURE="sha256=\$SIGNATURE_HEX"
HTTP=\$(curl -sS -o /tmp/chalk-dispatch-body.txt -w '%{http_code}' -X POST "\$WORKER_URL/dispatch" \
  -H 'content-type: application/json' \
  -H "X-Chalk-Timestamp: \$TIMESTAMP" \
  -H "X-Chalk-Signature: \$SIGNATURE" \
  --data "\$BODY")
printf 'http=%s\n' "\$HTTP"
cat /tmp/chalk-dispatch-body.txt
EOF

REMOTE_B64="$(printf '%s' "$REMOTE_SCRIPT" | base64 | tr -d '\n')"
PARAMS="$(jq -nc --arg cmd "echo $REMOTE_B64 | base64 -d | bash" '{commands:[$cmd]}')"

COMMAND_ID="$(
  AWS_PROFILE="$AWS_PROFILE_NAME" AWS_REGION="$AWS_REGION_NAME" aws --no-cli-pager ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --document-name AWS-RunShellScript \
    --parameters "$PARAMS" \
    --query 'Command.CommandId' \
    --output text
)"

printf '%s\n' "$COMMAND_ID"
