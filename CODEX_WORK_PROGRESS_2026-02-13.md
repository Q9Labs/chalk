# Codex Work Progress 2026-02-13

Notes: scoped to Codex changes only. No secrets/tokens. Timestamp timezone: PKT.

- 14:38 PKT: Decision lock: tenant kind `external|internal`; meetings no-signup; dashboard requires email magic-link (Resend); opaque join links; signed share links; delete recordings at 7d only (tombstone rooms).
- 14:39 PKT: Implemented schema groundwork: `tenants.tenant_kind`, `tenants.owner_user_id/claimed_at`, plus `users`, `user_sessions`, `tenant_claims`. Added permission gate: `/api/v1/recordings/*` requires `CanRecord`.
- 14:40 PKT: Gate run: `apps/api go test ./...` ok; monorepo `bun run lint`, `bun run check-types`, `bun run test` ok.

## Plan (Dashboard + Auth + Links)

1. API auth (Resend):
   - `POST /api/v1/internal/auth/start` (email -> magic link)
   - `POST /api/v1/internal/auth/verify` (token -> session cookie; bind internal tenant claim)
   - `GET /api/v1/internal/auth/access-token` (session cookie OR claim cookie -> mint tenant JWT)
2. Internal tenant lifecycle:
   - auto-create `tenants.tenant_kind='internal'` + `tenant_claims` + httpOnly claim cookie on first host action
   - enforce 1:1 `users` <-> internal tenant via unique partial index (already in migration)
3. Opaque join links:
   - `POST /api/v1/rooms/:id/join-token` (host JWT -> join token)
   - `POST /api/v1/public/join-token/exchange` (join token -> short-lived participant-scoped JWT)
   - web app: host replaces URL with `?jt=...`; guests use it; tokenProvider uses exchange endpoint
4. Signed share links:
   - `POST /api/v1/recordings/:id/share` (host JWT -> share token)
   - `GET /api/v1/public/share/:token` (public meeting detail: recording presign + transcript + metadata)
   - web app route `/share/:token`
5. Dashboard endpoints:
   - `GET /api/v1/internal/meetings` (host JWT -> meetings table rows: room + recording + transcript status)
6. Retention:
   - job: delete only recordings (storage + row) for internal tenants older than 7d
7. Web app changes:
   - remove browser API key dependency
   - add `/auth/callback` + `/dashboard` + `/share/:token` + join-token flow handling
- 14:54 PKT: Start implementation: internal auth endpoints, join/share token endpoints, dashboard API.
- 15:32 PKT: Wired new routes in `apps/api/internal/interfaces/http/router.go`: internal magic-link auth, internal meetings, public join-token exchange, public share link, host-only join-token + share-token creation. Tightened `/rooms` management endpoints to host-only (create/list/update/delete/end + bulk participants + refresh token + recordings sync).
- 15:34 PKT: Fixed sqlc/pgtype mismatches in `apps/api/internal/interfaces/http/handlers/internal_auth.go`. `apps/api go test ./...` passing.
- 15:48 PKT: Retention + archiving: excluded `tenant_kind='internal'` from `ListRecordingsReadyForArchive` (lifecycle manager won’t Glacier-archive internal). Added `InternalRetentionJob` wired in `apps/api/cmd/main.go` to hard-delete internal tenant recordings after 7d.
- 15:53 PKT: Internal always-on transcription: webhook recording-ready now queues post-meeting transcript for `tenant_kind='internal'` (idempotent; default provider). Updated router wiring + tests; `apps/api go test ./...` passing.
- 15:56 PKT: Dashboard access control: `GET /api/v1/internal/meetings` now requires the internal tenant to be claimed (`owner_user_id` set) so dashboard is “email login only”; meeting join can still work via claim cookie.
- 16:10 PKT: Web app wiring (apps/web): added internal tokenProvider (cookies + join token exchange), routes `/dashboard`, `/auth/callback`, `/j/:token`, `/share/:token`. Room page role now auto-switches host vs participant based on join context; host can copy invite link (internal-only, no API key mode).
- 16:45 PKT: Prod config: created AWS Secrets Manager secrets `chalk/prod/resend-api-key` and `chalk/prod/auth-link-signing-key`; attached execution-role permissions; updated ECS task definition `chalk-prod-api` to include internal auth env vars + secret refs; service stable. Infra IaC updated to reference the same secrets (no secret values committed).
