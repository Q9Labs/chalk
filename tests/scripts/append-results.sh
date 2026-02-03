#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Usage: ./append-results.sh <scenario> <k6-summary-json> <k6-exit-code> [k6-jsonl-output]
SCENARIO=$1
K6_OUTPUT=$2
K6_EXIT_CODE=${3:-}
K6_JSONL=${4:-}
RESULTS_FILE="$PROJECT_ROOT/tests/results/STRESS_TEST_RESULTS.md"

# Ensure results directory exists
mkdir -p "$PROJECT_ROOT/tests/results"

# Initialize file if it doesn't exist
if [ ! -f "$RESULTS_FILE" ]; then
  cat > "$RESULTS_FILE" << 'HEADER'
# Chalk Stress Test Results

> Auto-generated report. Each test run appends results below.

## Test Environment
- **Infrastructure**: chalk-stress (AWS us-east-1)
- **Test Framework**: k6 + Artillery + Custom Go Client

---

## Results Log

<!-- New results are appended below this line -->
HEADER
fi

# Extract metrics from k6 JSON output
TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")
HTTP_REQS=$(jq -r '.metrics.http_reqs.count // .metrics.http_reqs.values.count // 0' "$K6_OUTPUT")
HTTP_FAILED=$(jq -r '.metrics.http_req_failed.value // .metrics.http_req_failed.rate // .metrics.http_req_failed.values.rate // 0' "$K6_OUTPUT")
HTTP_P95=$(jq -r '.metrics.http_req_duration["p(95)"] // .metrics.http_req_duration.values["p(95)"] // 0' "$K6_OUTPUT")
HTTP_P99=$(jq -r '.metrics.http_req_duration["p(99)"] // .metrics.http_req_duration.values["p(99)"] // 0' "$K6_OUTPUT")
CHECKS_PASSED=$(jq -r '.metrics.checks.passes // .metrics.checks.values.passes // 0' "$K6_OUTPUT")
CHECKS_FAILED=$(jq -r '.metrics.checks.fails // .metrics.checks.values.fails // 0' "$K6_OUTPUT")

ROOMS_CREATED=$(jq -r '.metrics.rooms_created.count // .metrics.rooms_created.values.count // 0' "$K6_OUTPUT")
PARTICIPANT_JOINS=$(jq -r '.metrics.participant_joins.count // .metrics.participant_joins.values.count // 0' "$K6_OUTPUT")
PARTICIPANTS_JOINED=$(jq -r '.metrics.participants_joined.count // .metrics.participants_joined.values.count // 0' "$K6_OUTPUT")
BROADCAST_P95=$(jq -r '.metrics.broadcast_latency["p(95)"] // .metrics.broadcast_latency.values["p(95)"] // 0' "$K6_OUTPUT")
WS_SENT_RATE=$(jq -r '.metrics.ws_msgs_sent.rate // .metrics.ws_msgs_sent.values.rate // 0' "$K6_OUTPUT")
WS_RECV_RATE=$(jq -r '.metrics.ws_msgs_received.rate // .metrics.ws_msgs_received.values.rate // 0' "$K6_OUTPUT")
MESSAGES_ATTEMPTED=$(jq -r '.metrics.messages_attempted.count // .metrics.messages_attempted.values.count // 0' "$K6_OUTPUT")
MESSAGES_RATE_LIMITED=$(jq -r '.metrics.messages_rate_limited.count // .metrics.messages_rate_limited.values.count // 0' "$K6_OUTPUT")
RATE_LIMIT_RATE=$(jq -r '.metrics.rate_limit_rate.value // .metrics.rate_limit_rate.rate // .metrics.rate_limit_rate.values.rate // 0' "$K6_OUTPUT")

# Calculate pass/fail status
PASS_THRESHOLD_P95=2000  # 2 seconds
PASS_THRESHOLD_ERROR=0.01  # 1% error rate

if [ -n "$K6_EXIT_CODE" ]; then
  if [ "$K6_EXIT_CODE" -eq 0 ]; then
    STATUS="✅ PASS"
  else
    STATUS="❌ FAIL"
  fi
else
  if (( $(echo "$HTTP_P95 < $PASS_THRESHOLD_P95" | bc -l) )) && \
     (( $(echo "$HTTP_FAILED < $PASS_THRESHOLD_ERROR" | bc -l) )); then
    STATUS="✅ PASS"
  else
    STATUS="❌ FAIL"
  fi
fi

SUMMARY_NAME="$(basename "$K6_OUTPUT")"
ARTIFACTS="summary=${SUMMARY_NAME}"
if [ -n "${K6_JSONL:-}" ]; then
  ARTIFACTS="${ARTIFACTS}, k6_jsonl=$(basename "$K6_JSONL")"
fi

# Append results
cat >> "$RESULTS_FILE" << EOF

### $SCENARIO - $TIMESTAMP

**Status**: $STATUS
**Artifacts**: $ARTIFACTS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | $HTTP_REQS | - |
| Error Rate | $(printf "%.4f" $HTTP_FAILED) | < 0.01 |
| p95 Latency | $(printf "%.0f" $HTTP_P95) ms | < 2000 ms |
| p99 Latency | $(printf "%.0f" $HTTP_P99) ms | < 5000 ms |
| Checks Passed | $CHECKS_PASSED | - |
| Checks Failed | $CHECKS_FAILED | 0 |
| Rooms Created | $ROOMS_CREATED | - |
| Participant Joins | $PARTICIPANT_JOINS | - |
| Participants Joined | $PARTICIPANTS_JOINED | - |
| Broadcast p95 | $(printf "%.0f" $BROADCAST_P95) ms | - |
| WS Msgs Sent (rate) | $(printf "%.2f" $WS_SENT_RATE)/s | - |
| WS Msgs Recv (rate) | $(printf "%.2f" $WS_RECV_RATE)/s | - |
| Messages Attempted | $MESSAGES_ATTEMPTED | - |
| Messages Rate Limited | $MESSAGES_RATE_LIMITED | - |
| Rate Limit Rate | $(printf "%.4f" $RATE_LIMIT_RATE) | - |

<details>
<summary>Raw Output</summary>

\`\`\`
$(cat "$K6_OUTPUT" | head -100)
\`\`\`

</details>

---
EOF

echo "Results appended to $RESULTS_FILE"
echo "Status: $STATUS"
