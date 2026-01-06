# DevOps Engineering Skill

**Core Principle:** Always explore first. Never assume - discover current state.

## Step 1: Explore Before Acting

Use Explore agent to discover:

- `.github/workflows/` - triggers, dispatch inputs, job dependencies, path filters
- `infrastructure/terraform/` - structure, modules, environments, state backend
- Deployment targets - ECS/K8s, Pages/S3, databases, Redis
- Config files - Dockerfiles, env's, build configs

## Step 2: Check Current State

```bash
# Workflows
gh run list --branch <main-branch> --limit 10
gh run view <run-id> --log-failed

# ECS
aws ecs list-clusters --region <region>
aws ecs list-services --cluster <cluster> --region <region>
aws ecs describe-services --cluster <cluster> --services <service> --region <region>

# Running vs latest image
aws ecs describe-tasks --cluster <cluster> --tasks <task-arn> --region <region> --query 'tasks[0].containers[0].imageDigest'
aws ecr describe-images --repository-name <repo> --region <region> --query 'imageDetails | sort_by(@, &imagePushedAt) | [-1]'

# Static sites
wrangler pages deployments list --project-name <project>

# Terraform state
aws dynamodb scan --table-name <lock-table> --region <region>
```

## Step 3: Debugging

**Always check logs first:**

```bash
# Container logs
aws logs tail <log-group> --follow --region <region>

# Build logs
gh run view <run-id> --log-failed
```

## Step 4: Common Issues

> **Troubleshooting:** See `.github/CI_ERRORS.md` for comprehensive error reference.
>
> **Project-specific:** Check `DEPLOYMENT_NOTES.md` for this repo's known issues.

## Step 5: Triggering Deployments

```bash
# Discover inputs first
cat .github/workflows/<workflow>.yml | grep -A 30 "workflow_dispatch:"

# Trigger
gh workflow run <workflow>.yml -f <input>=<value>

# Watch
gh run watch <run-id> --exit-status
aws ecs wait services-stable --cluster <cluster> --services <service> --region <region>
```

## Step 6: Verification

```bash
# ECS - new revision deployed?
aws ecs describe-services --cluster <cluster> --services <service> --region <region> --query 'services[0].{taskDef:taskDefinition,deployments:deployments}'

# Health checks passing?
aws elbv2 describe-target-health --target-group-arn <tg-arn> --region <region>

# Static site serving new version?
curl -I https://<domain>/ | grep -i "cf-ray\|etag"

# Terraform clean?
terraform plan -detailed-exitcode
```

## Step 7: Terraform

```bash
# Safe apply
terraform init && terraform plan -out=tfplan && terraform apply tfplan

# State issues
terraform force-unlock <lock-id>
terraform apply -refresh-only
terraform import <resource>.<name> <id>
```

## Key Reminders

1. **Explore first** - Use Explore agent before any action
2. **Logs answer everything** - Check CloudWatch/Actions logs first
3. **ECS has TWO security groups** - instances + tasks, allow both in DB/Redis
4. **Force redeploy** - `latest` tag won't trigger ECS update
5. **Build vs runtime env** - `VITE_*` baked at build time
