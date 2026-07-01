#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

timestamp="$(date -u +"%Y%m%dT%H%M%SZ")"
repo_root="$(cd ../.. && pwd)"
raw_dir="${CHALK_API_PERF_RAW_DIR:-${repo_root}/.private/api-perf-${timestamp}}"
report="${CHALK_API_PERF_REPORT:-${repo_root}/scratchpad/api-performance-report-${timestamp}.md}"
html_report="${CHALK_API_PERF_HTML_REPORT:-${repo_root}/scratchpad/api-performance-report-${timestamp}.html}"
addr="${CHALK_API_PERF_ADDR:-127.0.0.1:18080}"
load_duration="${CHALK_API_PERF_LOAD_DURATION:-20s}"
load_concurrency="${CHALK_API_PERF_LOAD_CONCURRENCY:-32}"
stress_duration="${CHALK_API_PERF_STRESS_DURATION:-20s}"
stress_concurrency="${CHALK_API_PERF_STRESS_CONCURRENCY:-128}"
seed_tenants="${CHALK_API_PERF_SEED_TENANTS:-64}"

mkdir -p "${raw_dir}" "$(dirname "${report}")"

./scripts/dev-postgres.sh start
./scripts/db-migrate.sh up

go build -o "${raw_dir}/chalk-api" ./cmd
go build -o "${raw_dir}/chalk-api-perf" ./cmd/perf

"${raw_dir}/chalk-api-perf" \
  -server "${raw_dir}/chalk-api" \
  -addr "${addr}" \
  -log-dir "${raw_dir}" \
  -report "${report}" \
  -html-report "${html_report}" \
  -load-duration "${load_duration}" \
  -load-concurrency "${load_concurrency}" \
  -stress-duration "${stress_duration}" \
  -stress-concurrency "${stress_concurrency}" \
  -seed-tenants "${seed_tenants}"
