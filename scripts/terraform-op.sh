#!/usr/bin/env bash
set -euo pipefail

env_file="${CHALK_TF_ENV_FILE:-.private/chalk-terraform.env}"
tf_dir="${CHALK_TF_DIR:-infrastructure/terraform/environments/prod}"
backend_config="${CHALK_TF_BACKEND_CONFIG:-.private/terraform/prod.backend.hcl}"
op_account="${CHALK_OP_ACCOUNT:-${OP_ACCOUNT:-}}"

if [[ $# -eq 0 ]]; then
  cat >&2 <<'EOF'
Usage: bash scripts/terraform-op.sh <terraform command> [args...]

Examples:
  bash scripts/terraform-op.sh init
  bash scripts/terraform-op.sh plan
  bash scripts/terraform-op.sh apply
EOF
  exit 2
fi

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI (op) is required." >&2
  exit 1
fi

if ! command -v terraform >/dev/null 2>&1; then
  echo "terraform is required." >&2
  exit 1
fi

if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy infrastructure/terraform/op.env.example and point each value at your vault items." >&2
  exit 1
fi

if [[ ! -d "$tf_dir" ]]; then
  echo "Missing Terraform directory: $tf_dir" >&2
  echo "Set CHALK_TF_DIR to a Terraform environment directory." >&2
  exit 1
fi

tf_args=("$@")
if [[ "${tf_args[0]}" == "init" && -f "$backend_config" ]]; then
  has_backend_config="false"
  for arg in "${tf_args[@]}"; do
    if [[ "$arg" == -backend-config=* || "$arg" == "-backend-config" ]]; then
      has_backend_config="true"
      break
    fi
  done
  if [[ "$has_backend_config" == "false" ]]; then
    tf_args+=("-backend-config=${backend_config}")
  fi
fi

op_args=()
if [[ -n "$op_account" ]]; then
  op_args+=(--account "$op_account")
fi

exec op "${op_args[@]}" run --env-file "$env_file" -- terraform -chdir="$tf_dir" "${tf_args[@]}"
