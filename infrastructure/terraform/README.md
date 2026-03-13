# Chalk Terraform

Minimal orientation only. Source of truth lives in the Terraform files.

## Scope

- keep `bootstrap/`
- keep `environments/prod-lean/`
- keep only modules used by `environments/prod-lean/`

## Usage

Bootstrap remote state once:

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform apply
```

Work on the active environment:

```bash
cd infrastructure/terraform/environments/prod-lean
terraform init
terraform plan
terraform apply
```

## Ground truth

For current inputs, providers, outputs, and resources, read:

- `bootstrap/main.tf`
- `environments/prod-lean/main.tf`
- `environments/prod-lean/variables.tf`
- `environments/prod-lean/outputs.tf`

This README stays intentionally small to reduce drift.
