# DevOps Engineering Skill

DevOps work for this project - infrastructure, CI/CD, deployments.

## Before Any Action

**Always check current state first.** Never assume - infrastructure/CI configs change frequently.

## Step 1: Explore CI/CD Infrastructure

Use Explore agent to understand:

- GitHub Actions in `.github/workflows/` - triggers, conditions, job dependencies
- Commit flags/keywords controlling CI behavior (workflow_dispatch inputs)
- Terraform structure in `infrastructure/terraform/`
- Deployment targets (ECS, Cloudflare Pages, package registries)
- Container/build flow: Docker → ECR → ECS (backend) or Bun build → Pages (frontend)

## Step 2: Check Current State

### Workflow Runs
```bash
# Recent workflow runs
gh run list --branch master --limit 5

# Check specific workflow status
gh run view <run-id> --log-failed
```

### ECS (Backend API)
```bash
# Clusters and services (adjust region as needed)
aws ecs list-clusters --region us-east-1
aws ecs list-services --cluster <cluster-name> --region us-east-1
aws ecs describe-services --cluster <cluster-name> --services <service-names> --region us-east-1

# Latest ECR images
aws ecr describe-images --repository-name <repo> --region us-east-1 \
  --query 'imageDetails | sort_by(@, &imagePushedAt) | [-3:]'

# Running task image vs ECR image
aws ecs list-tasks --cluster <cluster> --service-name <service> --region us-east-1
aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> --region us-east-1 \
  --query 'tasks[0].containers[0].imageDigest'
```

### Cloudflare Pages (Frontend)
```bash
# Check recent deployments
wrangler pages deployments list --project-name <project-name>

# View deployment logs
wrangler pages deployment tail --project-name <project-name>
```

### Terraform State
```bash
# Check state bucket and lock table
aws s3 ls s3://<terraform-state-bucket>/
aws dynamodb describe-table --table-name <terraform-lock-table> --region us-east-1
```

## Step 3: Debugging Issues

### ECS Task Failures

**ALWAYS check CloudWatch logs FIRST when tasks fail or return HTTP 500:**

```bash
# Get recent logs (replace log-group-name with actual ECS service log group)
aws logs describe-log-streams --log-group-name "/aws/ecs/<service-name>" \
  --order-by LastEventTime --descending --limit 1 --region us-east-1 \
  --query 'logStreams[0].logStreamName' --output text | \
  xargs -I {} aws logs get-log-events --log-group-name "/aws/ecs/<service-name>" \
  --log-stream-name {} --region us-east-1 --limit 100 \
  --query 'events[*].message' --output json | jq -r '.[]'
```

### Cloudflare Pages Build Failures

```bash
# Check build logs
wrangler pages deployment tail --project-name <project-name>

# Verify build configuration
cat apps/web/.pages.yaml  # or wrangler.toml
```

### Package Publishing Issues

```bash
# Check GitHub Packages registry authentication
gh auth status

# Test package publish (dry run)
cd packages/<package-name>
npm publish --dry-run --registry=https://npm.pkg.github.com
```

## Step 4: Common Issues

| Issue                               | Cause                                                     | Fix                                                                                                        |
| ----------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **HTTP 500 from ECS task**          | App crash at startup (env validation, missing deps)       | Check CloudWatch logs for actual error message                                                             |
| Terraform state checksum mismatch   | S3 digest ≠ DynamoDB lock table                           | Update DynamoDB `Digest` field to match calculated checksum in error                                       |
| ECS tasks not updating              | New images pushed but task definition unchanged           | Force new deployment: `aws ecs update-service --cluster <cluster> --service <svc> --force-new-deployment` |
| Workflow failures                   | Various                                                   | Run `gh run view <id> --log-failed` before retrying                                                        |
| **New image not live after deploy** | Task def uses `latest` tag; ECS doesn't detect change     | Force redeploy with `--force-new-deployment` flag                                                          |
| Pages build fails                   | Missing env vars or build command mismatch                | Check VITE_* vars in Pages settings, verify build output path                                              |
| Package publish auth failure        | Expired GitHub token or missing .npmrc                    | Run `gh auth refresh`, verify registry URL in package.json                                                 |
| Terraform plan shows drift         | Manual changes in AWS console or state out of sync        | Review plan carefully, import resources if needed, or apply to reconcile                                   |
| ECS circuit breaker triggered       | Failed health checks or repeated deployment failures      | Check ALB target group health, verify container health check endpoint                                      |
| Aurora connection limit reached     | Too many idle connections or connection pool misconfigured | Adjust RDS max_connections or app pool size, check for connection leaks                                    |

## Step 5: Triggering Deployments

### Manual Workflow Dispatch

Use `workflow_dispatch` inputs for controlled deployments:

```bash
# Trigger API deploy with flags
gh workflow run api.yml -f skip_tests=true -f force_deploy=true -f environment=prod

# Trigger infrastructure changes
gh workflow run infra.yml -f environment=dev -f action=apply -f auto_approve=true

# Trigger frontend deploy
gh workflow run web.yml -f force_deploy=true
```

### Commit-Based Triggers

Workflows auto-trigger on path changes:
- **API:** Push to `apps/api/**` on master
- **Web:** Push to `apps/web/**` or `packages/**` on master
- **SDK:** Push to `packages/**` on master (publish on `v*` tags)
- **Infra:** Push to `infrastructure/terraform/**` on master

### Watching Deployments

```bash
# Watch workflow run in real-time
gh run watch <run-id> --exit-status

# Monitor ECS service deployment
aws ecs wait services-stable --cluster <cluster> --services <service> --region us-east-1

# Tail CloudWatch logs
aws logs tail /aws/ecs/<service-name> --follow --region us-east-1
```

## Step 6: Verification

After deployment, verify:

### ECS (Backend)
- [ ] New task definition revision created
- [ ] ECS service shows PRIMARY deployment with correct task count
- [ ] Running task's image digest matches latest ECR image digest
- [ ] Old deployments DRAINING or removed
- [ ] Health checks passing (target group healthy count)
- [ ] CloudWatch logs show no startup errors

### Cloudflare Pages (Frontend)
- [ ] New deployment ID created
- [ ] Deployment status shows "Success"
- [ ] Custom domain serving latest version
- [ ] Assets loading correctly (check browser network tab)

### Terraform
- [ ] Plan shows expected changes (or no changes if already applied)
- [ ] Apply completed without errors
- [ ] State lock released (no stuck locks in DynamoDB)
- [ ] Outputs match expected values

### Packages
- [ ] Package versions bumped correctly
- [ ] Published to GitHub Packages registry
- [ ] Tarball downloadable with proper auth

## Key Principle

**Never assume - always check current state first.**

## Environment Patterns

| Aspect                | Prod                       | Dev                       | Notes                                      |
| --------------------- | -------------------------- | ------------------------- | ------------------------------------------ |
| AWS Region            | Varies by project          | Varies by project         | Check terraform backend config             |
| ECS Instance Type     | Larger (e.g., t3.large)    | Smaller (e.g., t3.small)  | Cost optimization in dev                   |
| ECS Desired Count     | 2+ (HA)                    | 1 (cost savings)          | Multi-AZ in prod, single-AZ in dev         |
| Aurora Multi-AZ       | Yes                        | Optional                  | Dev may use single-AZ for cost             |
| NAT Gateways          | 3 (one per AZ)             | 1 (shared)                | High availability vs cost trade-off        |
| Terraform Auto-Apply  | Requires manual approval   | Can use auto_approve flag | Safety gate for production                 |
| Git Branch            | master                     | dev (if exists)           | Branch protection rules apply              |
| Domain Pattern        | app.domain.com             | dev-app.domain.com        | Cloudflare DNS + API Gateway custom domain |
| Monitoring Alarms     | Strict thresholds          | Relaxed thresholds        | Avoid alarm fatigue in dev                 |
| WAF Rate Limits       | Conservative (100 req/5m)  | Relaxed (1000 req/5m)     | Balance security and dev testing           |
| CloudWatch Retention  | 30-90 days                 | 7-14 days                 | Cost vs compliance requirements            |
| Backup Retention      | 7-35 days                  | 1-7 days                  | RDS automated backups                      |

## Disaster Recovery (terraform destroy/apply)

**Fully automated** after these prerequisites:

1. **Bootstrap State Backend First:**
   ```bash
   cd infrastructure/terraform/bootstrap
   terraform init && terraform apply
   # Copy outputs to environment backend configs
   ```

2. **GitHub Secrets Configured:**
   - AWS OIDC role ARN for auth (no long-lived credentials)
   - Cloudflare API tokens (for DNS, Pages, R2)
   - Any app-specific secrets (JWT keys, API tokens)

3. **Environment Backend Config:**
   ```hcl
   # environments/{env}/backend.tf
   terraform {
     backend "s3" {
       bucket         = "<state-bucket>"
       key            = "terraform.tfstate"
       region         = "us-east-1"
       dynamodb_table = "<lock-table>"
       encrypt        = true
     }
   }
   ```

4. **Deploy Infrastructure:**
   ```bash
   cd infrastructure/terraform/environments/prod
   terraform init
   terraform plan -out=tfplan
   terraform apply tfplan
   ```

5. **Deploy Application:**
   - Trigger API workflow (builds Docker image → pushes to ECR → deploys to ECS)
   - Trigger web workflow (builds static site → deploys to Cloudflare Pages)

6. **Verify DNS & TLS:**
   - ACM certificate validation via Cloudflare DNS (automatic)
   - Custom domain CNAME records point to correct targets
   - TLS terminates at ALB (backend) or Cloudflare (frontend)

## Debugging Terraform

### State Lock Issues
```bash
# Check lock table
aws dynamodb scan --table-name <lock-table> --region us-east-1

# Force unlock (use with caution)
terraform force-unlock <lock-id>
```

### State Drift
```bash
# Compare actual vs desired state
terraform plan -detailed-exitcode

# Refresh state from AWS
terraform apply -refresh-only

# Import manually created resources
terraform import <resource-type>.<name> <resource-id>
```

### Module Dependency Issues
```bash
# Visualize dependency graph
terraform graph | dot -Tpng > graph.png

# Target specific modules
terraform plan -target=module.vpc
terraform apply -target=module.vpc

# Destroy in reverse order
terraform destroy -target=module.monitoring
terraform destroy -target=module.ecs
```
