#!/bin/bash
# Usage: flip-nightly.sh false|unset   (DRY=1 writes nothing)
# Sets or removes CHALK_SFU_UNIFIED_SIGNALING in the nightly (staging) API env SSM value. It takes effect only after a nightly API
# redeploy. Never use it for production. Prints no values.
set -euo pipefail
mode=${1:?false|unset}
export AWS_PROFILE=q9labs AWS_REGION=ap-southeast-1
name=/chalk/nightly/managed-episode/api.env
old=$(mktemp)
new=$(mktemp)
trap 'rm -f "$old" "$new"' EXIT
aws ssm get-parameter --name "$name" --with-decryption --query Parameter.Value --output text > "$old"
before=$(aws ssm get-parameter --name "$name" --query Parameter.Version --output text)
{
  grep -v '^CHALK_SFU_UNIFIED_SIGNALING=' "$old" || true
  if [ "$mode" = false ]; then echo 'CHALK_SFU_UNIFIED_SIGNALING=false'; fi
} > "$new"
echo "version before: $before; lines $(wc -l < "$old") -> $(wc -l < "$new"); key set before: $(grep -c '^CHALK_SFU_UNIFIED_SIGNALING=' "$old" || true)"
[ "${DRY:-0}" = 1 ] && exit 0
aws ssm put-parameter --name "$name" --type SecureString --tier Advanced --overwrite --value "file://$new" --query Version --output text
