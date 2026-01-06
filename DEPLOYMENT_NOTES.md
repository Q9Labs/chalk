# Deployment Notes

Quick reference for deployment issues and fixes.

## Cloudflare Pages (Web Frontend)

### Pages Project Setup
- **Production domain**: `chalk.q9labs.ai` → attached to `chalk` project (NOT `chalk-web`)
- **Deploy command**: `wrangler pages deploy --project-name=chalk --branch=master`
- **Branch**: Must use `master` for production (project configured with master as prod branch)

### TanStack Start SPA Mode
- SSR requires Cloudflare Workers permission (our token only has Pages)
- Using SPA mode: `spa: { enabled: true }` in `tanstackStart()` plugin
- TanStack outputs `_shell.html` → must copy to `index.html` for Pages SPA fallback
- No `_redirects` needed - Pages auto-serves index.html for all routes when no 404.html exists

### Environment Variables
- `VITE_API_URL` must be set at build time (not runtime)
- Default fallback in code: `https://chalk-api.q9labs.ai`
- Pass `apiUrl` prop to `ChalkProvider`

## Go API (ECS)

### CORS Configuration
- File: `apps/api/internal/interfaces/http/middleware/cors.go`
- Must add production domains to `allowedOrigins` map
- Current allowed: localhost:3000/3070, chalk.q9labs.ai, chalk-5bc.pages.dev

### Test Quirks
- Config test expects port 8081 (not 8080) - matches actual default in config.go

## AWS API Gateway

### VPC Link TLS Configuration
- API Gateway connects to internal ALB via VPC Link
- `TlsConfig.ServerNameToVerify` must match the ACM certificate domain (`chalk-api.q9labs.ai`)
- NOT the internal ALB DNS name (`internal-chalk-prod-*.elb.amazonaws.com`)
- Fix command: `aws apigatewayv2 update-integration --api-id <id> --integration-id <id> --tls-config ServerNameToVerify=chalk-api.q9labs.ai`

### API Mapping
- Custom domain `chalk-api.q9labs.ai` uses root mapping (empty key)
- Requests go directly to backend without path prefix stripping
- `/health` → `/health`, `/api/v1/*` → `/api/v1/*`

### Security Groups (Manual Additions)
ECS tasks SG (`sg-0dcfc32590d21fc75`) needs access to:
- Aurora SG (`sg-0d7b000fdea80643a`) on port 5432
- Redis SG (`sg-046488938b1194507`) on port 6379

Commands used:
```bash
aws ec2 authorize-security-group-ingress --group-id sg-0d7b000fdea80643a --protocol tcp --port 5432 --source-group sg-0dcfc32590d21fc75
aws ec2 authorize-security-group-ingress --group-id sg-046488938b1194507 --protocol tcp --port 6379 --source-group sg-0dcfc32590d21fc75
```

TODO: Codify these rules in Terraform
