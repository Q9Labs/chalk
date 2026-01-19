#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Load config
ENV_FILE="$PROJECT_ROOT/tests/load/k6/.env"
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"
else
  echo "Error: $ENV_FILE not found."
  echo "Run setup-test-env.sh first, or create .env manually with:"
  echo "  BASE_URL=https://your-api-url"
  echo "  WS_URL=wss://your-api-url/ws"
  echo "  TENANT_ID=your-tenant-id"
  echo "  API_KEY=your-api-key"
  exit 1
fi

# Verify prerequisites
command -v k6 >/dev/null 2>&1 || { echo "Error: k6 not found. Install with: brew install k6"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found. Install with: brew install jq"; exit 1; }

PHASE=${1:-"smoke"}
K6_DIR="$PROJECT_ROOT/tests/load/k6"
RESULTS_DIR="$PROJECT_ROOT/tests/results"

# Ensure results directory exists
mkdir -p "$RESULTS_DIR"

echo "=== Running $PHASE Tests ==="
echo "Target: $BASE_URL"

run_k6() {
  local scenario=$1
  local script=$2
  local output="$RESULTS_DIR/${scenario}-$(date +%Y%m%d-%H%M%S).json"

  k6 run \
    -e BASE_URL="$BASE_URL" \
    -e WS_URL="$WS_URL" \
    -e TENANT_ID="$TENANT_ID" \
    -e API_KEY="$API_KEY" \
    --out "json=$output" \
    "$script"

  # Append results to persistent file
  "$SCRIPT_DIR/append-results.sh" "$scenario" "$output"
}

case "$PHASE" in
  smoke)
    run_k6 "smoke" "$K6_DIR/scenarios/smoke.js"
    ;;

  room-creation)
    run_k6 "room-creation" "$K6_DIR/scenarios/room-creation.js"
    ;;

  participant-churn)
    run_k6 "participant-churn" "$K6_DIR/scenarios/participant-churn.js"
    ;;

  large-room)
    run_k6 "large-room" "$K6_DIR/scenarios/large-room.js"
    ;;

  ws-storm)
    run_k6 "ws-storm" "$K6_DIR/scenarios/ws-storm.js"
    ;;

  all)
    for scenario in smoke room-creation participant-churn large-room ws-storm; do
      echo ""
      echo "=== Running $scenario ==="
      "$0" "$scenario"
      echo "Cooling down for 60 seconds..."
      sleep 60
    done
    # Generate summary after all tests
    "$SCRIPT_DIR/generate-summary.sh"
    ;;

  *)
    echo "Unknown phase: $PHASE"
    echo "Usage: $0 {smoke|room-creation|participant-churn|large-room|ws-storm|all}"
    exit 1
    ;;
esac

echo ""
echo "=== Test Complete ==="
echo "Results: $RESULTS_DIR/STRESS_TEST_RESULTS.md"
