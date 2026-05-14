# Prod Terraform Environment

Tracked production environment composition lives here. Concrete backend config,
tfvars, account IDs, provider tokens, and other environment values stay private
and are loaded through 1Password.

## Usage

```bash
cd infrastructure/terraform/environments/prod
terraform init -backend-config=/path/to/private/backend.hcl
op run --env-file ../../../../.private/chalk-terraform.env -- terraform plan
op run --env-file ../../../../.private/chalk-terraform.env -- terraform apply
```

From the repo root, prefer the wrapper:

```bash
CHALK_TF_DIR=infrastructure/terraform/environments/prod pnpm run infra:tf -- plan
```

## Ground truth

Read these files for the current state of the environment:

- `main.tf`
- `variables.tf`
- `outputs.tf`

This README stays intentionally small to reduce drift.
