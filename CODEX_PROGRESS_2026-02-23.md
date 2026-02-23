# Codex Progress — 2026-02-23

- 07:35: Implemented lean control-plane infra scaffolding.
- Added Terraform module `ec2-api-lean` (EC2 + IAM + SSM env fetch + Caddy + Docker + alarms).
- Added Terraform environment `environments/prod-lean` with providers: AWS, Cloudflare, Upstash, PlanetScale.
- Wired SSM runtime env population from Terraform outputs/secrets for API runtime.
- Added DNS A records for `chalk-api` + `chalk-ws` to lean EIP.
- Added arm64 deploy workflow `api-lean.yml` (ECR + SSM restart + health probe).
- Added infra workflow `infra-lean.yml` for plan/apply/destroy.
- Updated API Dockerfile for `TARGETARCH` multi-arch build support.
- Added DB pool env tunables (`DATABASE_MAX_CONNS`, `DATABASE_MIN_CONNS`) and validation.
- Added docs: lean cutover runbook + control-plane cost baseline.
- 08:59: Retried lean apply after PlanetScale token update; apply still fails at PlanetScale role create endpoint (404 on org/db/branch path).
- 08:59: Added workflow support for optional PLANETSCALE_BRANCH secret (fallback main) in plan/destroy var injection.
- 08:59: Updated prod-lean README example to include planetscale_branch input.
