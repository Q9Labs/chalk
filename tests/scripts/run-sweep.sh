#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE="$PROJECT_ROOT/tests/load/k6/.env"
RUN_TESTS="$PROJECT_ROOT/tests/scripts/run-tests.sh"
COLLECT_INFRA_SNAPSHOT="$PROJECT_ROOT/tests/scripts/collect-infra-snapshot.sh"
RESULTS_DIR="$PROJECT_ROOT/tests/results"
SWEEP_RESULTS_FILE="$RESULTS_DIR/SWEEP_RESULTS.md"
LOCK_FILE="/tmp/chalk-stress-sweep.lock"

K6_SWEEP_START="${K6_SWEEP_START:-200}"
K6_SWEEP_END="${K6_SWEEP_END:-750}"
K6_SWEEP_STEP="${K6_SWEEP_STEP:-50}"
K6_SWEEP_SCENARIOS="${K6_SWEEP_SCENARIOS:-large-room,ws-storm}"
K6_SWEEP_LONG_POINTS="${K6_SWEEP_LONG_POINTS:-200,first-fail,750}"
K6_SWEEP_COOLDOWN_SECONDS="${K6_SWEEP_COOLDOWN_SECONDS:-60}"
K6_COLLECT_INFRA_SNAPSHOT="${K6_COLLECT_INFRA_SNAPSHOT:-true}"

die() {
  echo "Error: $*" >&2
  exit 1
}

contains_token() {
  local list="$1"
  local token="$2"
  [[ ",$list," == *",$token,"* ]]
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found"
}

collect_snapshot() {
  local start_time="$1"
  local end_time="$2"
  local label="$3"

  [ "$K6_COLLECT_INFRA_SNAPSHOT" = "true" ] || return 0

  if [ ! -f "$COLLECT_INFRA_SNAPSHOT" ]; then
    echo "Warn: missing $COLLECT_INFRA_SNAPSHOT; skipping infra snapshot."
    return 0
  fi

  if ! bash "$COLLECT_INFRA_SNAPSHOT" "$start_time" "$end_time" "$label"; then
    echo "Warn: infra snapshot failed for $label; continuing sweep."
  fi
}

run_one() {
  local scenario="$1"
  local vu="$2"
  local short="$3"
  local summary_file=""
  local jsonl_file=""
  local status=0
  local log_file="$RESULTS_DIR/sweep-${scenario}-${vu}-$(date +%Y%m%d-%H%M%S).log"

  K6_ACTIVE_USERS="$vu" K6_SHORT="$short" "$RUN_TESTS" "$scenario" >"$log_file" 2>&1 || status=$?
  summary_file="$(ls -1t "$RESULTS_DIR/${scenario}-"*"-summary.json" 2>/dev/null | head -1 || true)"
  jsonl_file="$(ls -1t "$RESULTS_DIR/${scenario}-"*.jsonl 2>/dev/null | head -1 || true)"

  echo "$status|$summary_file|$jsonl_file|$log_file"
}

mkdir -p "$RESULTS_DIR"

if [ -f "$LOCK_FILE" ]; then
  existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
  if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
    die "Another sweep is already running (pid=$existing_pid). Remove $LOCK_FILE if stale."
  fi
fi
echo "$$" >"$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

echo "=== Chalk Stress Sweep ==="
echo "VUs: $K6_SWEEP_START → $K6_SWEEP_END (step $K6_SWEEP_STEP)"
echo "Scenarios: $K6_SWEEP_SCENARIOS"
echo "Cooldown: ${K6_SWEEP_COOLDOWN_SECONDS}s"

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run ./tests/scripts/setup-test-env.sh first."
[ -x "$RUN_TESTS" ] || die "$RUN_TESTS not executable"

require_cmd k6
require_cmd jq
require_cmd bc
if [ "$K6_COLLECT_INFRA_SNAPSHOT" = "true" ]; then
  require_cmd terraform
  require_cmd aws
fi

IFS=',' read -r -a scenarios <<<"$K6_SWEEP_SCENARIOS"

echo "" >"$SWEEP_RESULTS_FILE"
{
  echo "# Sweep Results"
  echo ""
  echo "- Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- VUs: $K6_SWEEP_START → $K6_SWEEP_END (step $K6_SWEEP_STEP)"
  echo "- Scenarios: $K6_SWEEP_SCENARIOS"
  echo "- Long points: $K6_SWEEP_LONG_POINTS"
  echo ""
  echo "| VUs | large-room (short) | ws-storm (short) | First-fail confirmed (long) | Notes |"
  echo "| ---: | --- | --- | --- | --- |"
} >>"$SWEEP_RESULTS_FILE"

first_fail_vu=""
first_fail_confirmed="false"

echo ""
echo "Smoke at ${K6_SWEEP_START} VUs (short)..."
K6_ACTIVE_USERS="$K6_SWEEP_START" K6_SHORT=true "$RUN_TESTS" smoke || true

for ((vu = K6_SWEEP_START; vu <= K6_SWEEP_END; vu += K6_SWEEP_STEP)); do
  echo ""
  echo "=== Step: ${vu} VUs (short) ==="
  step_start_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  large_room_cell=""
  ws_storm_cell=""
  notes=""

  step_failed="false"
  failing_scenarios=()

  for scenario in "${scenarios[@]}"; do
    out="$(run_one "$scenario" "$vu" "true")"
    IFS='|' read -r status summary jsonl log_file <<<"$out"

    cell="PASS"
    [ "$status" -eq 0 ] || cell="FAIL"
    [ -n "$summary" ] && cell="$cell ($(basename "$summary"))"
    [ -n "$jsonl" ] && cell="$cell [k6:$(basename "$jsonl")]"
    [ -n "$log_file" ] && cell="$cell [log:$(basename "$log_file")]"

    case "$scenario" in
      large-room) large_room_cell="$cell" ;;
      ws-storm) ws_storm_cell="$cell" ;;
      *) notes="${notes}${scenario}:${cell} " ;;
    esac

    if [ "$status" -ne 0 ]; then
      step_failed="true"
      failing_scenarios+=("$scenario")
    fi
  done

  # First failure confirmation (long) once.
  if [ "$step_failed" = "true" ] && [ -z "$first_fail_vu" ]; then
    first_fail_vu="$vu"
    if contains_token "$K6_SWEEP_LONG_POINTS" "first-fail"; then
      echo ""
      echo "First fail at ${vu} VUs — confirming long for failing scenarios: ${failing_scenarios[*]}"
      for scenario in "${failing_scenarios[@]}"; do
        K6_ACTIVE_USERS="$vu" K6_SHORT=false "$RUN_TESTS" "$scenario" || true
      done
      first_fail_confirmed="true"
    fi
  fi

  # Baseline long at sweep start (if requested)
  if [ "$vu" -eq "$K6_SWEEP_START" ] && contains_token "$K6_SWEEP_LONG_POINTS" "$K6_SWEEP_START"; then
    echo ""
    echo "Baseline long at ${K6_SWEEP_START} VUs..."
    for scenario in "${scenarios[@]}"; do
      K6_ACTIVE_USERS="$K6_SWEEP_START" K6_SHORT=false "$RUN_TESTS" "$scenario" || true
    done
  fi

  # Final long at sweep end (if requested)
  if [ "$vu" -eq "$K6_SWEEP_END" ] && contains_token "$K6_SWEEP_LONG_POINTS" "$K6_SWEEP_END"; then
    echo ""
    echo "Final long at ${K6_SWEEP_END} VUs..."
    for scenario in "${scenarios[@]}"; do
      K6_ACTIVE_USERS="$K6_SWEEP_END" K6_SHORT=false "$RUN_TESTS" "$scenario" || true
    done
  fi

  if [ "$step_failed" = "true" ]; then
    notes="thresholds failed"
  fi

  step_end_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  snapshot_label="sweep-vu-${vu}"
  if [ "$step_failed" = "true" ]; then
    snapshot_label="${snapshot_label}-failed"
  fi
  collect_snapshot "$step_start_time" "$step_end_time" "$snapshot_label"

  {
    echo "| $vu | ${large_room_cell:-N/A} | ${ws_storm_cell:-N/A} | ${first_fail_confirmed} | ${notes:-} |"
  } >>"$SWEEP_RESULTS_FILE"

  if [ "$vu" -lt "$K6_SWEEP_END" ]; then
    echo "Cooldown ${K6_SWEEP_COOLDOWN_SECONDS}s..."
    sleep "$K6_SWEEP_COOLDOWN_SECONDS"
  fi
done

echo ""
echo "=== Sweep Complete ==="
echo "Results: $SWEEP_RESULTS_FILE"
