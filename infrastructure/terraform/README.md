# Chalk Terraform Modules

This directory contains reusable Terraform modules and safe environment
composition for Chalk-style deployments. Concrete backend config, tfvars,
account IDs, provider tokens, and production values are intentionally not
tracked.

## Scope

- reusable modules live under `modules/`
- tracked environment composition lives under `environments/`
- state backends, resolved tfvars, account IDs, tokens, and production values
  stay private

## Usage

Initialize and plan from an environment:

```bash
cd infrastructure/terraform/environments/prod
terraform init
terraform plan
```

For private deployments, prefer the 1Password wrapper so values are loaded as
environment variables at runtime:

```bash
pnpm run infra:tf -- plan
```

Copy `op.env.example` to `.private/chalk-terraform.env` and point each variable
at the dedicated project vault. Keep backend config in
`.private/terraform/prod.backend.hcl`.

## Ground truth

For module inputs, outputs, and resources, read the files under `modules/`.

This README stays intentionally small to reduce drift.
