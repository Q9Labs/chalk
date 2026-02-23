# Prod Lean Environment

Cost-first control-plane stack for Chalk:

- API runtime: `EC2 t4g.micro` (single instance)
- DB: PlanetScale Postgres
- Redis: Upstash Redis
- Storage: Cloudflare R2
- Runtime secrets/env: AWS SSM Parameter Store (`/chalk/prod/api/*`)

## Apply

```bash
cd infrastructure/terraform/environments/prod-lean
terraform init
terraform plan \
  -var="cloudflare_api_token=..." \
  -var="cloudflare_account_id=..." \
  -var="r2_access_key_id=..." \
  -var="r2_secret_access_key=..." \
  -var="upstash_email=..." \
  -var="upstash_api_key=..." \
  -var="planetscale_service_token_id=..." \
  -var="planetscale_service_token=..." \
  -var="planetscale_organization=..." \
  -var="planetscale_database=..." \
  -var="planetscale_branch=main" \
  -var="cloudflare_app_id=..." \
  -var="cloudflare_app_token=..." \
  -var="jwt_signing_key=..." \
  -var="admin_secret=..."
terraform apply
```

## Notes

- Bootstraps an arm64 host and runs API from ECR.
- Caddy handles TLS for `chalk-api` + `chalk-ws` domains.
- Deploys are done by pushing image then restarting service via SSM.
- Keep `cloudflare_proxy_enabled=false` when using ACME HTTP challenge from origin.
