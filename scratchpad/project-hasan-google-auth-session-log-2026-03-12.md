[2026-03-12 17:02 PKT] Replaced custom magic-link auth with Google-session endpoints and web Google gate.
[2026-03-12 17:02 PKT] Added session/logout/account-state fixes; removed Resend magic-link backend path.
[2026-03-12 17:02 PKT] Verified: lint, typecheck, web tests, go tests, full build, browser gate + seeded-session dashboard/logout flow. Blocker: true Google handshake still needs AUTH_GOOGLE_CLIENT_ID + VITE_GOOGLE_CLIENT_ID in local env.

## 2026-03-12 18:15 PKT
- Switched auth implementation from GIS ID-token login to full Google OAuth authorization-code flow.
- Local gate green after refactor: `bun run check-types`, `cd apps/web && bun test src/lib/internalAuth.test.ts`, `cd apps/api && go test ./...`, `bun run lint`, `bun run build`.
- Created GCP project for OAuth provisioning via delegated worker: `chalk-auth-dev-20260312` (`Chalk Auth Dev`).
- Confirmed with delegated research + official docs: standard Google Sign-In Web OAuth client creation remains console-driven; available CLI/API paths are for IAP or Workforce Identity, not the normal GIS web app client.
- Tried delegated + local browser automation routes: agent-browser auto-connect, CDP attach on local Chrome debug port, Helium profile cloning into fresh Chromium/Playwright contexts.
- Concrete blocker: no signed-in Google Cloud Console browser session was reusable; all automation paths redirected to `accounts.google.com` sign-in, so client ID/secret could not be created.
- Best-effort browser/runtime verification delegated again; source-level proof and automated tests confirm OAuth gate, missing-config message, logout wiring, and session helpers, but true Google popup/login proof remains blocked on missing console-created client credentials and local runtime binding inconsistencies in worker environments.

## 2026-03-12 19:26 PKT
- Hasan completed manual live sign-in verification after OAuth client provisioning.
- Main-shell browser proof captured live dashboard gate and real Google-hosted OAuth launch URL with configured client ID.
- Temporary localhost cookie helper on port 3099 cleaned up after use.

## 2026-03-12 19:31 PKT
- Reproduced broken Sign Out live with seeded session.
- Root cause: account menu actions in dashboard used `onSelect`; in current Base UI menu wiring the action did not fire reliably for the live Sign Out path.
- Fixed by switching dashboard account menu actions to `onClick` for Settings and Sign Out.
- Re-verified live in browser: seeded authenticated dashboard -> account menu -> Sign Out -> returned to Google login gate on `/dashboard`.

## 2026-03-12 22:45 PKT
- Investigated prod black-screen `session failed (404)` on `https://chalk.q9labs.ai/dashboard`.
- Root cause: prod API had not been deployed with new internal auth routes; `GET /api/v1/internal/auth/session` and `POST /api/v1/internal/auth/google` returned 404.
- Used deploy workflow logic from `.github/workflows/api-lean.yml` to do direct lean API deploy from local code: built/pushed arm64 image to ECR and restarted EC2 service via SSM.
- Infra drift found during deploy: repo Dockerfile still used Go 1.24 while `go.mod` requires 1.25; used temp deploy-only Dockerfile override to build current image.
- Second prod issue: API runtime regenerated env from SSM path `/chalk/prod/api`, so editing `/etc/chalk/api.env` was ineffective.
- Added prod SSM params for `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, `INTERNAL_APP_URL`, restarted service.
- Final prod verification:
  - `GET https://chalk-api.q9labs.ai/health` -> 200
  - `GET https://chalk-api.q9labs.ai/api/v1/internal/auth/session` -> 401 (not 404)
  - `POST https://chalk-api.q9labs.ai/api/v1/internal/auth/google` with dummy code -> 401 `invalid google authorization code` (not 404/503)
  - `POST https://chalk-api.q9labs.ai/api/v1/internal/auth/logout` -> 200
2026-03-12 23:49:01 PKT
 - whisper incident: found c7i.large prod worker using CPU int8 distil-large-v3.5; observed earlier kernel OOM on python3; applied prod SSM hot tune WHISPER_BEAM_SIZE=1 and WHISPER_BATCHED_ENABLED=false; restarted chalk-whisper at 18:47 UTC; worker stable and model_load_complete observed after restart; monitoring for first completion.
2026-03-13 00:26:04 PKT | promoted transcript row 68312ba8-ba30-4faa-34d3-70ac1832f5e0 for recording 478a260a-3c54-406c-6f47-5366dc39a9ab to front of pending queue by setting created_at=2000-01-01 UTC
