# Chalk Infrastructure - Terraform

AWS infrastructure for Chalk video conferencing platform.

## Architecture

- **VPC** - Multi-AZ networking (public, private, database subnets)
- **ECS on EC2** - Auto-scaling containers
- **Aurora Serverless v2** - PostgreSQL
- **ElastiCache** - Redis (WebSocket pub/sub, sessions)
- **API Gateway v2** - HTTP + WebSocket with VPC Link
- **WAF** - Rate limiting, SQL injection protection
- **CloudWatch** - Monitoring, logging, alerting
- **Cloudflare** - Calls SFU/TURN, R2 recordings

## Quick Start

### 1. Bootstrap (One-time)

```bash
cd infrastructure/terraform/bootstrap
terraform init && terraform apply
# Copy outputs to environment backend configs
```

### 2. Deploy Environment

```bash
cd infrastructure/terraform/environments/dev
terraform init && terraform apply
```

## Structure

```
infrastructure/terraform/
├── bootstrap/         # State backend (S3 + DynamoDB)
├── modules/           # VPC, ECS, Aurora, ElastiCache, API Gateway, WAF, monitoring, ECR, Cloudflare
└── environments/      # dev, staging, prod
```

## Environment Configs

| Env | VPC | ECS | Aurora ACU | Redis | Cost/mo |
|-----|-----|-----|------------|-------|---------|
| dev | 10.0/16, 2 AZ, 1 NAT | t3.small, 1-2 | 0.5-2 | t3.micro, 1 node | ~$120 |
| staging | 10.1/16, 2 AZ, 1 NAT | t3.medium, 2-4 | 1-4 | t3.small, 2 nodes | ~$250 |
| prod | 10.2/16, 3 AZ, 1 NAT | t3.small, 1-2 | 0.5-2 | t3.micro, 2 nodes | ~$174 |

## Outputs

```bash
terraform output  # API endpoints, DB connection, Secret ARNs, CloudWatch URLs, ECR repo
```

## Secrets

Stored in AWS Secrets Manager:
- `chalk/{env}/jwt-secret`
- `chalk/{env}/cloudflare`
- `chalk/{env}/api-config`
- Aurora password (auto-generated)
- Redis token (auto-generated)

## Monitoring

**Dashboards:** ECS CPU/Memory, ALB latency/errors, Aurora connections, Redis usage, API Gateway metrics

**Alarms:** CPU/Memory >80%, 5XX >50/5min, p99 >500ms, DB connections >80%

## CI/CD

`.github/workflows/infra.yml`:
1. Validate on PR
2. Plan for dev
3. Auto-apply dev on merge
4. Manual approval for staging/prod

**Required secrets:** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID

## Troubleshooting

```bash
terraform force-unlock <lock-id>    # State lock stuck
terraform fmt -recursive            # Format code
cd modules/<module> && terraform init -backend=false && terraform validate  # Validate module
```

## Costs Breakdown

| Component | Dev | Staging | Prod |
|-----------|-----|---------|------|
| ECS | $15 | $61 | $15 |
| Aurora | $44 | $88 | $44 |
| ElastiCache | $12 | $25 | $24 |
| NAT Gateway | $33 | $33 | $33 |
| ALB + API GW | $26 | $30 | $26 |
| Other (WAF, KMS, CW) | $10 | $20 | $32 |
| **Total** | **~$140** | **~$257** | **~$174** |

*Excludes API Gateway usage (pay-per-request) and data transfer. Cloudflare usage-based (R2 + Calls minutes).*

**Note:** Prod is right-sized for ~200 MAU. Scale up ECS/Aurora/Redis as load grows.

## Requirements

- Terraform >= 1.9
- AWS Provider ~> 5.80
- Cloudflare Provider ~> 5
