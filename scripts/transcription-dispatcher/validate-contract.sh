#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE_DIR="$ROOT_DIR/infrastructure/opentofu/modules/aws-transcription-dispatcher"
LIFECYCLE_DIR="$ROOT_DIR/infrastructure/opentofu/modules/cloudflare-r2-transcription-lifecycle"
fail() { echo "transcription dispatcher contract: $*" >&2; exit 1; }
require() { rg -q -- "$1" "$2" || fail "missing '$1' in $2"; }

require 'required_version = "= 1\.12\.3"' "$MODULE_DIR/versions.tf"
require 'version = "= 5\.90\.0"' "$MODULE_DIR/versions.tf"
require 'runtime       = "nodejs22\.x"' "$MODULE_DIR/main.tf"
require 'reserved_concurrent_executions = var\.reserved_concurrency' "$MODULE_DIR/main.tf"
require 'default     = 50' "$MODULE_DIR/variables.tf"
require 'var\.reserved_concurrency >= 3' "$MODULE_DIR/main.tf"
require 'var\.timeout_seconds - var\.work_budget_seconds >= var\.completion_reserve_seconds' "$MODULE_DIR/main.tf"
require 'default     = 60' "$MODULE_DIR/variables.tf"
require 'maximum_retry_attempts       = var\.async_maximum_retry_attempts' "$MODULE_DIR/main.tf"
require 'maximum_event_age_in_seconds = var\.async_max_event_age_seconds' "$MODULE_DIR/main.tf"
require '1048576' "$MODULE_DIR/variables.tf"
require 'destination_config' "$MODULE_DIR/main.tf"
require 'schedule_expression[[:space:]]+= "rate\(1 minute\)"' "$MODULE_DIR/main.tf"
require 'mode = "OFF"' "$MODULE_DIR/main.tf"
require 'dead_letter_config' "$MODULE_DIR/main.tf"
require 'source_code_hash' "$MODULE_DIR/main.tf"
require 's3_object_version' "$MODULE_DIR/main.tf"
require 'ssm:GetParameter' "$MODULE_DIR/main.tf"
require 'ssm:GetParameters' "$MODULE_DIR/main.tf"
require 'sqs:SendMessage' "$MODULE_DIR/main.tf"
require 'DEEPINFRA_TOKEN_PARAMETER_ARN' "$MODULE_DIR/main.tf"
require 'CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN' "$MODULE_DIR/main.tf"
require 'CONTROL_API_AUDIENCE' "$MODULE_DIR/main.tf"
require 'vpc_egress_allowlist' "$MODULE_DIR/variables.tf"
require 'vpc_egress_mode == "nat"' "$MODULE_DIR/variables.tf"
require 'ALLOW_DIRTY_SOURCE' "$ROOT_DIR/scripts/transcription-dispatcher/build-release.sh"
require 'dirty-local-proof' "$ROOT_DIR/scripts/transcription-dispatcher/verify-artifact.sh"
require 'source_tree_digest' "$ROOT_DIR/scripts/transcription-dispatcher/emit-manifest.mjs"
require 'pnpm-lock\.yaml' "$ROOT_DIR/scripts/transcription-dispatcher/build-release.sh"
require 'transcription/chunks/' "$LIFECYCLE_DIR/variables.tf"
require 'transcription/orphans/' "$LIFECYCLE_DIR/variables.tf"
require 'temporary_expiration_hours == 24' "$LIFECYCLE_DIR/variables.tf"
require 'committed_cleanup_deadline_hours.*<= 1' "$LIFECYCLE_DIR/variables.tf"
require 'finalized_transcript_prefix' "$LIFECYCLE_DIR/main.tf"

APP_CONFIG="$ROOT_DIR/apps/transcription-dispatcher/src/config.ts"
APP_INDEX="$ROOT_DIR/apps/transcription-dispatcher/src/index.ts"
if [[ -f "$APP_CONFIG" && -f "$APP_INDEX" ]]; then
  for key in CONTROL_API_BASE_URL CONTROL_API_AUDIENCE TRANSCRIPTION_MAX_BATCH TRANSCRIPTION_CONCURRENCY TRANSCRIPTION_TIMEOUT_RESERVE_MS TRANSCRIPTION_PRIVACY_GATE_ACCEPTED DEEPINFRA_ENABLED DEEPINFRA_EXECUTION_IDENTITY_PIN DEEPINFRA_MODEL_VERSION_PIN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_MODEL_SLUG CLOUDFLARE_ADAPTER_CONTRACT_VERSION CLOUDFLARE_CORPUS_DIGEST TRANSCRIPTION_PROVIDER_TIMEOUT_MS TRANSCRIPTION_MAX_AUDIO_BYTES TRANSCRIPTION_MAX_AUDIO_SECONDS TRANSCRIPTION_MAX_RESPONSE_BYTES TRANSCRIPTION_MAX_TEXT_CHARS TRANSCRIPTION_MAX_SEGMENTS TRANSCRIPTION_MAX_WORDS TRANSCRIPTION_MAX_RETRIES TRANSCRIPTION_RETRY_BASE_DELAY_MS TRANSCRIPTION_RETRY_MAX_DELAY_MS TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD TRANSCRIPTION_CIRCUIT_COOLDOWN_MS; do
    rg -q -- "\\\"$key\\\"" "$APP_CONFIG" || fail "dispatcher config does not consume $key"
  done
  for key in DEEPINFRA_TOKEN_PARAMETER_ARN CLOUDFLARE_AI_TOKEN_PARAMETER_ARN CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN; do
    rg -q -- "\\\"$key\\\"" "$APP_INDEX" || fail "dispatcher SSM loader does not consume $key"
  done
fi

if rg -n 'r2:GetObject|s3:GetObject|r2:PutObject|r2:DeleteObject|rds:|dynamodb:|ec2:|iam:Create|iam:Put|iam:Attach|ssm:GetParametersByPath' "$MODULE_DIR"; then
  fail "broad database, reusable object-storage, or infrastructure-mutation permission found"
fi
echo "validated transcription dispatcher infrastructure contract"
