#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODULE_DIR="$ROOT_DIR/infrastructure/transcription-dispatcher"
fail() { echo "transcription dispatcher contract: $*" >&2; exit 1; }
require() { grep -qE -- "$1" "$2" || fail "missing '$1' in $2"; }
# Scans the files git does not ignore. A scan that cannot run fails the contract.
forbid() {
  local status=0
  git -C "$ROOT_DIR" grep --untracked -nE -- "$1" -- "$2" || status=$?
  [[ $status -ne 0 ]] || fail "$3"
  [[ $status -eq 1 ]] || fail "could not scan $2"
}

node "$ROOT_DIR/infrastructure/platform/check-preview-build.mjs"
require 'runtime: "nodejs22.x"' "$MODULE_DIR/resources.ts"
require 'reservedConcurrency: input.reserved_concurrency' "$MODULE_DIR/resources.ts"
require 'input.timeout_seconds - input.work_budget_seconds >= input.completion_reserve_seconds' "$MODULE_DIR/config.ts"
require 'MaximumRetryAttempts: news.eventInvokeConfig.maximumRetryAttempts' "$ROOT_DIR/infrastructure/providers/aws-versioned-function.ts"
require 'MaximumEventAgeInSeconds: news.eventInvokeConfig.maximumEventAge' "$ROOT_DIR/infrastructure/providers/aws-versioned-function.ts"
require '1048576' "$MODULE_DIR/config.ts"
require 'scheduleExpression: "rate\(1 minute\)"' "$MODULE_DIR/resources.ts"
require 'state: input.scheduler_state' "$MODULE_DIR/resources.ts"
require 'Mode: "OFF"' "$MODULE_DIR/resources.ts"
require 'DeadLetterConfig' "$MODULE_DIR/resources.ts"
require 'S3ObjectVersion: code.version' "$ROOT_DIR/infrastructure/providers/aws-versioned-function.ts"
require 'result.codeSha256 !== code.sha256' "$ROOT_DIR/infrastructure/providers/aws-versioned-function.ts"
require 'ssm:GetParameter' "$MODULE_DIR/resources.ts"
require 'ssm:GetParameters' "$MODULE_DIR/resources.ts"
require 'sqs:SendMessage' "$MODULE_DIR/resources.ts"
require 'OPENROUTER_TOKEN_PARAMETER_ARN' "$MODULE_DIR/environment.ts"
require 'CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN' "$MODULE_DIR/environment.ts"
require 'CONTROL_API_AUDIENCE' "$MODULE_DIR/environment.ts"
require 'control_api_invoke_policy_json' "$MODULE_DIR/resources.ts"
require 'required_egress_destinations' "$MODULE_DIR/resources.ts"
forbid 'VpcConfig:|SubnetIds:|SecurityGroupIds:|CHALK_EGRESS_ALLOWLIST' "$MODULE_DIR" \
  "dispatcher must retain default Lambda networking without VPC/NAT resources or a claimed network allowlist"
require 'ALLOW_DIRTY_SOURCE' "$ROOT_DIR/scripts/transcription-dispatcher/build-release.sh"
require 'dirty-local-proof' "$ROOT_DIR/scripts/transcription-dispatcher/verify-artifact.sh"
require 'source_tree_digest' "$ROOT_DIR/scripts/transcription-dispatcher/emit-manifest.mjs"
require 'pnpm-lock\.yaml' "$ROOT_DIR/scripts/transcription-dispatcher/build-release.sh"
pnpm --dir "$ROOT_DIR/infrastructure" check-types
pnpm --dir "$ROOT_DIR/infrastructure" test

APP_CONFIG="$ROOT_DIR/apps/transcription-dispatcher/src/config.ts"
if [[ -f "$APP_CONFIG" ]]; then
  for key in CONTROL_API_BASE_URL CONTROL_API_AUDIENCE TRANSCRIPTION_MAX_BATCH TRANSCRIPTION_CONCURRENCY TRANSCRIPTION_TIMEOUT_RESERVE_MS TRANSCRIPTION_PRIVACY_GATE_ACCEPTED TRANSCRIPTION_PROVIDER_TIMEOUT_MS TRANSCRIPTION_MAX_AUDIO_BYTES TRANSCRIPTION_MAX_AUDIO_SECONDS TRANSCRIPTION_MAX_RESPONSE_BYTES TRANSCRIPTION_MAX_TEXT_CHARS TRANSCRIPTION_MAX_SEGMENTS TRANSCRIPTION_MAX_WORDS TRANSCRIPTION_MAX_RETRIES TRANSCRIPTION_RETRY_BASE_DELAY_MS TRANSCRIPTION_RETRY_MAX_DELAY_MS TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD TRANSCRIPTION_CIRCUIT_COOLDOWN_MS; do
    grep -qF -- "\"$key\"" "$APP_CONFIG" || fail "dispatcher config does not consume $key"
  done
  for key in OPENROUTER_TOKEN_PARAMETER_ARN CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN; do
    grep -qF -- "\"$key\"" "$APP_CONFIG" || fail "dispatcher SSM parameter names omit $key"
  done
fi

forbid 'r2:GetObject|s3:GetObject|r2:PutObject|r2:DeleteObject|rds:|dynamodb:|ec2:|iam:Create|iam:Put|iam:Attach|ssm:GetParametersByPath' "$MODULE_DIR/resources.ts" \
  "broad database, reusable object-storage, or infrastructure-mutation permission found"
echo "validated transcription dispatcher infrastructure contract"
