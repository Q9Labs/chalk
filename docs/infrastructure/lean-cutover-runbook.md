# Lean Cutover Runbook

## Objective

Replace expensive control-plane infra with lean stack:

- EC2 `t4g.micro`
- PlanetScale Postgres
- Upstash Redis
- Cloudflare R2
- SSM-backed runtime env

No media-layer migration in this runbook.

## Preconditions

- `infra-lean.yml` applied successfully for `prod-lean`.
- `api-lean.yml` deploy green at least once.
- PlanetScale data migrated and verified.
- DNS records exist for `chalk-api` + `chalk-ws`.

## Smoke Test Checklist

- `GET /health` returns `200`.
- API key auth works.
- Room create/join/leave succeeds.
- WebSocket connect and message fanout works.
- Recording metadata writes work (if enabled).
- Internal auth routes (magic-link/session) work.

## 24h Stability Gate

Observe for 24h after traffic shift:

- API 5xx rate stable.
- p95 latency stable.
- Redis connectivity/reconnect stable.
- DB connection count below cap.
- No repeated service restarts on EC2.

## Rollback

If gate fails:

1. Roll back to previous known-good lean API image/config.
2. Keep failing lean revision artifacts (logs, metrics, timeline).
3. Capture failure timeline and diff since last green deploy.

## Decommission (post-gate)

Legacy stack removed. Keep this checklist for historical audits:

1. ECS service/cluster.
2. API Gateway + related VPC link resources.
3. Aurora + ElastiCache.
4. WAF/monitoring objects no longer referenced.
5. NAT/VPC components if unused by other systems.

## Safety Notes

- Take final DB backup/snapshot before destructive deletes.
- Confirm no external integrations still pinned to legacy endpoints.
- Keep Terraform state backups before destroy.
