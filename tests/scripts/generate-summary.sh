#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Generates a summary section at the top of the results file

RESULTS_FILE="$PROJECT_ROOT/tests/results/STRESS_TEST_RESULTS.md"
SUMMARY_FILE="$PROJECT_ROOT/tests/results/SUMMARY.md"

if [ ! -f "$RESULTS_FILE" ]; then
  echo "No results file found at $RESULTS_FILE"
  exit 1
fi

# Count results
TOTAL_TESTS=$(grep -c "^### " "$RESULTS_FILE" || true)
PASSED=$(grep -c "✅ PASS" "$RESULTS_FILE" || true)
FAILED=$(grep -c "❌ FAIL" "$RESULTS_FILE" || true)

# Calculate pass rate
if [ "$TOTAL_TESTS" -gt 0 ]; then
  PASS_RATE=$(echo "scale=1; $PASSED * 100 / $TOTAL_TESTS" | bc)
else
  PASS_RATE=0
fi

cat > "$SUMMARY_FILE" << EOF
# Stress Test Summary

**Generated**: $(date -u +"%Y-%m-%d %H:%M:%S UTC")

## Overview

| Metric | Value |
|--------|-------|
| Total Test Runs | $TOTAL_TESTS |
| Passed | $PASSED |
| Failed | $FAILED |
| Pass Rate | ${PASS_RATE}% |

## Recent Scenario Results

| Scenario | Timestamp | Status |
|----------|-----------|--------|
$(grep -E "^### " "$RESULTS_FILE" | tail -10 | while read -r line; do
  scenario=$(echo "$line" | sed 's/^### //' | cut -d' ' -f1)
  timestamp=$(echo "$line" | sed 's/^### [^ ]* - //')
  # Get status from next few lines in the file
  line_num=$(grep -n "$line" "$RESULTS_FILE" | head -1 | cut -d: -f1)
  status=$(sed -n "$((line_num+1)),$((line_num+3))p" "$RESULTS_FILE" | grep -o "✅ PASS\|❌ FAIL" | head -1)
  echo "| $scenario | $timestamp | $status |"
done)

## Recommendations

$(if [ "$FAILED" -gt 0 ]; then
  echo "⚠️ **Action Required**: $FAILED test(s) failed. Review detailed results."
else
  echo "✅ All tests passing. System appears ready for production load."
fi)

---

[Full Results](./STRESS_TEST_RESULTS.md)
EOF

echo "Summary generated at $SUMMARY_FILE"
