#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Usage: ./append-results.sh <scenario> <k6-json-output>
SCENARIO=$1
K6_OUTPUT=$2
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
HTTP_REQS=$(jq -r '.metrics.http_reqs.values.count // 0' "$K6_OUTPUT")
HTTP_FAILED=$(jq -r '.metrics.http_req_failed.values.rate // 0' "$K6_OUTPUT")
HTTP_P95=$(jq -r '.metrics.http_req_duration.values["p(95)"] // 0' "$K6_OUTPUT")
HTTP_P99=$(jq -r '.metrics.http_req_duration.values["p(99)"] // 0' "$K6_OUTPUT")
CHECKS_PASSED=$(jq -r '.metrics.checks.values.passes // 0' "$K6_OUTPUT")
CHECKS_FAILED=$(jq -r '.metrics.checks.values.fails // 0' "$K6_OUTPUT")

# Calculate pass/fail status
PASS_THRESHOLD_P95=2000  # 2 seconds
PASS_THRESHOLD_ERROR=0.01  # 1% error rate

if (( $(echo "$HTTP_P95 < $PASS_THRESHOLD_P95" | bc -l) )) && \
   (( $(echo "$HTTP_FAILED < $PASS_THRESHOLD_ERROR" | bc -l) )); then
  STATUS="✅ PASS"
else
  STATUS="❌ FAIL"
fi

# Append results
cat >> "$RESULTS_FILE" << EOF

### $SCENARIO - $TIMESTAMP

**Status**: $STATUS

| Metric | Value | Threshold |
|--------|-------|-----------|
| Total Requests | $HTTP_REQS | - |
| Error Rate | $(printf "%.4f" $HTTP_FAILED) | < 0.01 |
| p95 Latency | $(printf "%.0f" $HTTP_P95) ms | < 2000 ms |
| p99 Latency | $(printf "%.0f" $HTTP_P99) ms | < 5000 ms |
| Checks Passed | $CHECKS_PASSED | - |
| Checks Failed | $CHECKS_FAILED | 0 |

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
