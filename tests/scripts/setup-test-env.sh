#!/bin/bash
set -euo pipefail

# Get project root (directory containing this script's parent)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "=== Setting up Chalk Stress Test Environment ==="
echo "Project root: $PROJECT_ROOT"

# Variables
WORKSPACE="stress-test"
TERRAFORM_DIR="$PROJECT_ROOT/tests/infrastructure/terraform/stress-test"

# Verify prerequisites
command -v terraform >/dev/null 2>&1 || { echo "Error: terraform not found"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl not found"; exit 1; }

# Check for terraform.tfvars
if [ ! -f "$TERRAFORM_DIR/terraform.tfvars" ]; then
  echo "Error: terraform.tfvars not found"
  echo "Copy terraform.tfvars.example to terraform.tfvars and fill in values:"
  echo "  cp $TERRAFORM_DIR/terraform.tfvars.example $TERRAFORM_DIR/terraform.tfvars"
  exit 1
fi

# Initialize Terraform
echo "Initializing Terraform..."
terraform -chdir="$TERRAFORM_DIR" init

# Create workspace if it doesn't exist
terraform -chdir="$TERRAFORM_DIR" workspace select "$WORKSPACE" 2>/dev/null || \
  terraform -chdir="$TERRAFORM_DIR" workspace new "$WORKSPACE"

# Plan and apply
echo "Planning infrastructure..."
terraform -chdir="$TERRAFORM_DIR" plan -out=tfplan

echo "Applying infrastructure..."
terraform -chdir="$TERRAFORM_DIR" apply tfplan

# Get outputs
API_ENDPOINT=$(terraform -chdir="$TERRAFORM_DIR" output -raw api_endpoint)
LOAD_GEN_IPS=$(terraform -chdir="$TERRAFORM_DIR" output -json load_generator_ips | jq -r '.[]')
DASHBOARD_URL=$(terraform -chdir="$TERRAFORM_DIR" output -raw cloudwatch_dashboard_url)

echo ""
echo "=== Infrastructure Ready ==="
echo "API Endpoint: $API_ENDPOINT"
echo "Load Generators: $LOAD_GEN_IPS"
echo "CloudWatch Dashboard: $DASHBOARD_URL"

# Create test tenant
echo ""
echo "Creating test tenant..."
TENANT_RESPONSE=$(curl -s -X POST "$API_ENDPOINT/api/v1/tenants" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "stress-test-tenant",
    "max_concurrent_rooms": 1000,
    "max_participants_per_room": 200,
    "max_recording_duration_minutes": 120
  }')

TENANT_ID=$(echo "$TENANT_RESPONSE" | jq -r '.id')
API_KEY=$(echo "$TENANT_RESPONSE" | jq -r '.api_key')

if [ "$TENANT_ID" = "null" ] || [ -z "$TENANT_ID" ]; then
  echo "Error: Failed to create tenant"
  echo "Response: $TENANT_RESPONSE"
  exit 1
fi

echo "Tenant ID: $TENANT_ID"
echo "API Key: $API_KEY"

# Save config for tests
mkdir -p "$PROJECT_ROOT/tests/load/k6"
cat > "$PROJECT_ROOT/tests/load/k6/.env" <<EOF
BASE_URL=$API_ENDPOINT
WS_URL=${API_ENDPOINT/https:/wss:}/ws
TENANT_ID=$TENANT_ID
API_KEY=$API_KEY
EOF

echo ""
echo "=== Setup Complete ==="
echo "Config saved to: tests/load/k6/.env"
echo "Run tests with: ./tests/scripts/run-tests.sh smoke"
