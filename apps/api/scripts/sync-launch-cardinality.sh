#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

database_url="${CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL:-}"
if [[ -z "${database_url}" ]]; then
  echo "CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL is required" >&2
  exit 2
fi
if [[ "${database_url}" != *"@127.0.0.1:"* && "${database_url}" != *"@localhost:"* ]]; then
  echo "sync launch-cardinality proof only accepts a localhost database URL" >&2
  exit 2
fi

participant_count="${CHALK_SYNC_PLAN_PARTICIPANTS:-500}"
event_count="${CHALK_SYNC_PLAN_EVENTS:-250000}"
receipt_count="${CHALK_SYNC_PLAN_RECEIPTS:-500000}"
timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
output="${CHALK_SYNC_PLAN_OUTPUT:-../../.private/sync-launch-cardinality-${timestamp}.log}"

for dimension in "${participant_count}" "${event_count}" "${receipt_count}"; do
  if [[ ! "${dimension}" =~ ^[1-9][0-9]*$ ]]; then
    echo "launch-cardinality dimensions must be positive integers" >&2
    exit 2
  fi
done
if (( participant_count > 500 || event_count > 250000 || receipt_count > 500000 || receipt_count < event_count )); then
  echo "launch-cardinality dimensions exceed the declared Session budgets" >&2
  exit 2
fi

mkdir -p "$(dirname "${output}")"

psql "${database_url}" \
  --set participant_count="${participant_count}" \
  --set event_count="${event_count}" \
  --set receipt_count="${receipt_count}" \
  --file db/fixtures/sync_launch_cardinality.sql \
  | tee "${output}"

echo "launch-cardinality plan proof: ${output}"
