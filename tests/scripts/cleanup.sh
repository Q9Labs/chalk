#!/bin/bash
set -euo pipefail

# Get project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Cleaning Up Stress Test Environment ==="

TERRAFORM_DIR="$PROJECT_ROOT/tests/infrastructure/terraform/stress-test"
ENV_FILE="$PROJECT_ROOT/tests/load/k6/.env"
AWS_PROFILE_NAME=${AWS_PROFILE:-${AWS_CLI_PROFILE:-}}

# Load config and delete tenant
if [ -f "$ENV_FILE" ]; then
  source "$ENV_FILE"

  # Delete test data
  echo "Deleting test tenant and data..."
  curl -s -X DELETE "$BASE_URL/api/v1/tenants/$TENANT_ID" \
    -H "X-API-Key: $API_KEY" || true

  # Remove .env file
  rm -f "$ENV_FILE"
  echo "Removed $ENV_FILE"
fi

# Destroy infrastructure
echo "Destroying test infrastructure..."
terraform -chdir="$TERRAFORM_DIR" workspace select stress-test 2>/dev/null || true
if [ -n "$AWS_PROFILE_NAME" ]; then
  AWS_PROFILE="$AWS_PROFILE_NAME" terraform -chdir="$TERRAFORM_DIR" destroy -auto-approve
else
  terraform -chdir="$TERRAFORM_DIR" destroy -auto-approve
fi

echo ""
echo "=== Cleanup Complete ==="
