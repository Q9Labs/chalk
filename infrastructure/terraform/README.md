# Chalk Infrastructure - Terraform

Terraform infrastructure for Chalk control-plane.

## Stacks

### Legacy (`environments/prod`, `environments/dev`)

- VPC + NAT + ECS (EC2)
- Aurora PostgreSQL
- ElastiCache Redis
- API Gateway + WAF + CloudWatch-heavy setup

### Lean (`environments/prod-lean`)

- EC2 `t4g.micro` (single instance)
- PlanetScale Postgres
- Upstash Redis
- Cloudflare R2
- Cloudflare DNS + Caddy TLS on origin
- SSM Parameter Store for runtime env/secrets
- Minimal CloudWatch alarms

## Quick Start

### 1) Bootstrap state backend (one-time)

```bash
cd infrastructure/terraform/bootstrap
terraform init && terraform apply
```

### 2) Deploy lean prod

```bash
cd infrastructure/terraform/environments/prod-lean
terraform init
terraform plan
terraform apply
```

## Structure

```text
infrastructure/terraform/
├── bootstrap/
├── modules/
│   ├── ec2-api-lean/
│   └── ...legacy modules...
└── environments/
    ├── dev/
    ├── prod/
    └── prod-lean/
```

## CI/CD

- `infra.yml`: legacy infra plan/apply.
- `infra-lean.yml`: lean infra plan/apply/destroy.
- `api.yml`: legacy ECS API deploy.
- `api-lean.yml`: arm64 image build + EC2 SSM restart deploy.

## Requirements

- Terraform >= 1.9
- AWS provider ~> 5.80
- Cloudflare provider ~> 5
- Upstash provider ~> 2.1
- PlanetScale provider = 1.0.0-rc1

## Notes

- Lean stack is designed for cost-first control-plane operation.
- Media-layer cost is separate from this Terraform scope.
- For cutover/decommission flow, see `docs/infrastructure/lean-cutover-runbook.md`.
