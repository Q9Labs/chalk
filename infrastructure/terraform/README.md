# Chalk Infrastructure - Terraform

Production-ready infrastructure for Chalk video conferencing platform using AWS services.

## Architecture

- **VPC**: Multi-AZ networking with public, private, and database subnets
- **ECS on EC2**: Auto-scaling container orchestration with capacity providers
- **Aurora Serverless v2**: PostgreSQL-compatible database with automatic scaling
- **ElastiCache**: Redis cluster for WebSocket pub/sub and session management
- **API Gateway v2**: HTTP and WebSocket APIs with VPC Link integration
- **WAF**: Web Application Firewall with rate limiting and SQL injection protection
- **CloudWatch**: Comprehensive monitoring, logging, and alerting
- **Cloudflare**: Calls SFU/TURN apps for WebRTC and R2 bucket for recordings

## Quick Start

### 1. Bootstrap (One-time setup)

Create S3 bucket and DynamoDB table for Terraform state:

```bash
cd infrastructure/terraform/bootstrap
terraform init
terraform apply
```

Note the output values and update the backend configuration in each environment.

### 2. Deploy Development Environment

```bash
cd infrastructure/terraform/environments/dev

# Update backend config in main.tf with values from bootstrap
# Then initialize and apply
terraform init
terraform apply
```

### 3. Deploy to Other Environments

```bash
# Staging
cd infrastructure/terraform/environments/staging
terraform init
terraform apply

# Production
cd infrastructure/terraform/environments/prod
terraform init
terraform apply \
  -var="cloudflare_app_id=your_app_id" \
  -var="cloudflare_app_secret=your_app_secret" \
  -var="cors_allowed_origins=[\"https://yourdomain.com\"]"
```

## Module Structure

```
infrastructure/terraform/
├── bootstrap/              # State backend setup
├── modules/
│   ├── vpc/               # Networking
│   ├── ecs/               # Container orchestration
│   ├── aurora/            # PostgreSQL database
│   ├── elasticache/       # Redis cache
│   ├── api-gateway/       # HTTP + WebSocket APIs
│   ├── secrets/           # Secrets Manager
│   ├── waf/               # Web Application Firewall
│   ├── monitoring/        # CloudWatch dashboards & alarms
│   ├── ecr/               # Container registry
│   └── cloudflare/        # Calls SFU/TURN apps, R2 storage
└── environments/
    ├── dev/               # Development
    ├── staging/           # Staging
    └── prod/              # Production
```

## Environment Configurations

### Development
- **VPC**: 10.0.0.0/16, 2 AZs, single NAT Gateway
- **ECS**: t3.small instances, 1-2 capacity
- **Aurora**: 0.5-2 ACU, 1 instance
- **Redis**: cache.t3.micro, 1 node
- **Cost**: ~$210/month

### Staging
- **VPC**: 10.1.0.0/16, 2 AZs, single NAT Gateway
- **ECS**: t3.medium instances, 2-4 capacity
- **Aurora**: 1-4 ACU, 1 instance
- **Redis**: cache.t3.small, 2 nodes, Multi-AZ
- **Cost**: ~$400/month

### Production
- **VPC**: 10.2.0.0/16, 3 AZs, Multi-AZ NAT Gateways
- **ECS**: t3.large instances, 3-10 capacity
- **Aurora**: 2-16 ACU, 2 instances
- **Redis**: cache.r6g.large, 3 nodes, Multi-AZ
- **Cost**: ~$800/month (infrastructure only, excludes API Gateway usage)

## Outputs

Each environment outputs:

- API endpoints (HTTP & WebSocket)
- Database connection strings
- Secret ARNs for application configuration
- CloudWatch dashboard URLs
- ECR repository URL

```bash
terraform output
```

## Secrets Management

Secrets are stored in AWS Secrets Manager:

- `chalk/{env}/jwt-secret` - JWT signing key
- `chalk/{env}/cloudflare` - Cloudflare API credentials
- `chalk/{env}/api-config` - Application configuration
- Aurora master password (auto-generated)
- Redis AUTH token (auto-generated)

Access secrets from ECS tasks using IAM roles.

## Monitoring

CloudWatch dashboards include:

- ECS CPU/Memory utilization
- ALB request count, latency, and errors
- Aurora connection count and CPU
- Redis memory and CPU usage
- API Gateway metrics

Alarms configured for:

- High CPU/Memory (>80%)
- 5XX errors (>50 in 5 min)
- High latency (p99 >500ms)
- High database connections (>80% max)

## CI/CD

GitHub Actions workflow (`.github/workflows/infra.yml`) automates:

1. Validation on PR
2. Plan for dev environment
3. Auto-apply to dev on merge
4. Manual approval for staging/prod

Required secrets:
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `CLOUDFLARE_API_TOKEN` - API token with Calls and R2 permissions
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID

## Best Practices

1. **Never commit secrets** - Use Secrets Manager or environment variables
2. **Run plan before apply** - Always review changes
3. **Use workspaces carefully** - We use separate directories instead
4. **Version modules** - Pin module versions in production
5. **State locking** - Enabled via DynamoDB

## Troubleshooting

### State Lock Issues

```bash
terraform force-unlock <lock-id>
```

### Module Validation

```bash
cd modules/<module-name>
terraform init -backend=false
terraform validate
```

### Format Code

```bash
terraform fmt -recursive
```

## Costs

Estimated monthly costs by environment:

| Component | Dev | Staging | Prod |
|-----------|-----|---------|------|
| ECS | $15 | $61 | $200 |
| Aurora | $44 | $88 | $250 |
| ElastiCache | $12 | $25 | $150 |
| NAT Gateway | $32 | $32 | $96 |
| Other | $20 | $30 | $100 |
| Cloudflare | ~$0 | ~$10 | ~$50 |
| **Total** | **~$123** | **~$246** | **~$846** |

*Does not include API Gateway usage costs (pay-per-request) or data transfer. Cloudflare costs are usage-based (R2 storage + Calls minutes).*

## Support

For issues or questions:
1. Check Terraform validate output
2. Review CloudWatch logs
3. Check GitHub Actions workflow runs
4. Review AWS Console for resource status

## Version Requirements

- Terraform >= 1.9
- AWS Provider ~> 5.80
- Cloudflare Provider ~> 5
- Random Provider ~> 3.6
