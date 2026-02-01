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
AWS_REGION=${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}
AWS_PROFILE_NAME=${AWS_PROFILE:-${AWS_CLI_PROFILE:-}}
AWS_CLI_ARGS=()
if [ -n "$AWS_PROFILE_NAME" ]; then
  AWS_CLI_ARGS+=(--profile "$AWS_PROFILE_NAME")
fi

# Verify prerequisites
command -v terraform >/dev/null 2>&1 || { echo "Error: terraform not found"; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl not found"; exit 1; }
command -v aws >/dev/null 2>&1 || { echo "Error: aws CLI not found"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: docker not found"; exit 1; }

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

# Build and push API image to ECR
ECR_REPO=$(terraform -chdir="$TERRAFORM_DIR" output -raw ecr_repository_url)
ECR_REGISTRY=$(echo "$ECR_REPO" | cut -d/ -f1)
ECR_IMAGE="${ECR_REPO}:latest"

echo ""
echo "Building and pushing API image to ECR: $ECR_IMAGE"
aws "${AWS_CLI_ARGS[@]}" ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"
docker build -t "$ECR_IMAGE" "$PROJECT_ROOT/apps/api"
docker push "$ECR_IMAGE"

CLUSTER_NAME=$(terraform -chdir="$TERRAFORM_DIR" output -raw ecs_cluster_name)
SERVICE_NAME="${CLUSTER_NAME/-cluster/-api}"

# Force ECS to use the newly pushed image digest
IMAGE_DIGEST=$(aws "${AWS_CLI_ARGS[@]}" ecr describe-images --region "$AWS_REGION" \
  --repository-name "$(basename "$ECR_REPO")" \
  --image-ids imageTag=latest \
  --query 'imageDetails[0].imageDigest' --output text)

CURRENT_TD=$(aws "${AWS_CLI_ARGS[@]}" ecs describe-services --region "$AWS_REGION" --cluster "$CLUSTER_NAME" --services "$SERVICE_NAME" \
  --query 'services[0].taskDefinition' --output text)

NEW_TD_JSON=$(aws "${AWS_CLI_ARGS[@]}" ecs describe-task-definition --region "$AWS_REGION" --task-definition "$CURRENT_TD" \
  --query 'taskDefinition' --output json | \
  jq --arg img "${ECR_REPO}@${IMAGE_DIGEST}" '
    .containerDefinitions |= map(if .name == "api" then .image = $img else . end) |
    del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)')

NEW_TD_ARN=$(aws "${AWS_CLI_ARGS[@]}" ecs register-task-definition --region "$AWS_REGION" --cli-input-json "$NEW_TD_JSON" \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws "${AWS_CLI_ARGS[@]}" ecs update-service --region "$AWS_REGION" --cluster "$CLUSTER_NAME" --service "$SERVICE_NAME" \
  --task-definition "$NEW_TD_ARN" --force-new-deployment

# Wait for API health
echo ""
echo "Waiting for API health..."
for i in {1..60}; do
  if curl -s -o /dev/null -w "%{http_code}" "$API_ENDPOINT/health" | grep -q "^200$"; then
    echo "API is healthy."
    break
  fi
  echo "Health check not ready yet ($i/60). Waiting 10s..."
  sleep 10
done

# Create test tenant
echo ""
echo "Creating test tenant..."
TENANT_RESPONSE=$(curl -s -X POST "$API_ENDPOINT/api/v1/tenants" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "stress-test-tenant",
    "max_concurrent_rooms": 50000,
    "max_participants_per_room": 200,
    "max_recording_duration_minutes": 120,
    "max_total_minutes_of_meetings": 1000000
  }')

TENANT_ID=$(echo "$TENANT_RESPONSE" | jq -r '.tenant.id')
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
if [[ "$API_ENDPOINT" == https://* ]]; then
  WS_ENDPOINT="${API_ENDPOINT/https:/wss:}/ws"
else
  WS_ENDPOINT="${API_ENDPOINT/http:/ws:}/ws"
fi
cat > "$PROJECT_ROOT/tests/load/k6/.env" <<EOF
BASE_URL=$API_ENDPOINT
WS_URL=$WS_ENDPOINT
TENANT_ID=$TENANT_ID
API_KEY=$API_KEY
EOF

echo ""
echo "=== Setup Complete ==="
echo "Config saved to: tests/load/k6/.env"
echo "Run tests with: ./tests/scripts/run-tests.sh smoke"
