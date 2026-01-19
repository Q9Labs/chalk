#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Usage: ./append-custom-result.sh <scenario> <status> <notes>
# For manual observations or non-k6 tests

SCENARIO=$1
STATUS=$2  # "PASS" or "FAIL"
NOTES=${3:-"No additional notes"}
RESULTS_FILE="$PROJECT_ROOT/tests/results/STRESS_TEST_RESULTS.md"

TIMESTAMP=$(date -u +"%Y-%m-%d %H:%M:%S UTC")

if [ "$STATUS" = "PASS" ]; then
  STATUS_ICON="✅ PASS"
else
  STATUS_ICON="❌ FAIL"
fi

cat >> "$RESULTS_FILE" << EOF

### $SCENARIO - $TIMESTAMP

**Status**: $STATUS_ICON

**Notes**: $NOTES

---
EOF

echo "Custom result appended to $RESULTS_FILE"
