# Guided Code Review - API Auth Slice

## What Changed

- Added email/password register and login with canonical emails, bcrypt hashing, password bounds, and stable duplicate-email errors.
- Added Postgres-backed `login_sessions`; raw session tokens are returned once and only SHA-256 token hashes are persisted.
- Added auth middleware for `Authorization: Bearer <token>` and the HTTP-only `chalk_session` cookie.
- Added logout, `/v1/me`, and Google OAuth start/callback with Redis-backed state and PKCE verifier storage.
- Added auth config for session TTL, local/test email-verification behavior, Google OAuth, and OAuth state TTL.

## Routes And Behaviors

- `POST /v1/auth/register`: creates password identity and session, sets `chalk_session`.
- `POST /v1/auth/login`: validates password and creates session, sets `chalk_session`.
- `POST /v1/auth/logout`: requires current auth and revokes the current session, clears cookie.
- `GET /v1/me`: requires current auth and returns the authenticated user.
- `GET /v1/auth/google/start`: redirects to Google OAuth with state and PKCE.
- `GET /v1/auth/google/callback`: validates state/code, auto-creates Google users, rejects password-user email conflicts.

## Read First

- [authentication service](/Users/macmini/code/chalk/apps/api/internal/authentication/service.go:201): register, login, session auth, logout, and Google completion rules.
- [auth interfaces](/Users/macmini/code/chalk/apps/api/internal/authentication/service.go:128): service boundaries and adapter contracts.
- [HTTP auth routes](/Users/macmini/code/chalk/apps/api/internal/httpapi/auth.go:54): request parsing, response shape, cookie behavior, and route-level error mapping.
- [auth middleware](/Users/macmini/code/chalk/apps/api/internal/httpapi/middleware.go:13): bearer/cookie token lookup and principal context wiring.
- [/v1/me handler](/Users/macmini/code/chalk/apps/api/internal/httpapi/me.go:9): authenticated user response surface.
- [Postgres auth adapter](/Users/macmini/code/chalk/apps/api/internal/adapters/postgres/authentication.go:28): repository mapping, unique-conflict handling, session queries.
- [SQL auth queries](/Users/macmini/code/chalk/apps/api/db/queries/authentication.sql:1): password/Google identity creation and session reads/revocation.
- [Google adapter](/Users/macmini/code/chalk/apps/api/internal/adapters/google/oidc.go:25): OAuth URL, token exchange, ID token validation.
- [Redis state adapter](/Users/macmini/code/chalk/apps/api/internal/adapters/redis/oauth_state.go:12): OAuth state save and one-time load/delete.
- [runtime wiring](/Users/macmini/code/chalk/apps/api/cmd/main.go:112): auth service, cookies, optional Google/Redis adapters.
- [auth config](/Users/macmini/code/chalk/apps/api/internal/config/config.go:98): TTLs, email verification flag, Google OAuth settings.

## Tests To Inspect

- [auth service tests](/Users/macmini/code/chalk/apps/api/internal/authentication/service_test.go:1): email/password, token hashing, session validity, Google conflict.
- [HTTP route tests](/Users/macmini/code/chalk/apps/api/internal/httpapi/router_test.go:1): register/login/logout, `/me`, bearer/cookie auth, Google redirects/callback.
- [Postgres auth adapter tests](/Users/macmini/code/chalk/apps/api/internal/adapters/postgres/authentication_test.go:1): session create/read mapping and not-found behavior.
- [config tests](/Users/macmini/code/chalk/apps/api/internal/config/config_test.go:1): defaults and invalid auth setting rejection.

## Concerns And Tradeoffs

- Google sign-in is wired only when Google client credentials are configured; otherwise Google routes return a clear not-configured auth error.
- Email verification is config-driven and defaults off for local/test ergonomics; enabling it currently blocks password registration until the future verification flow exists.
- Google email conflicts deliberately do not auto-link to existing password users.
- The full API gate may be blocked by unrelated untracked object storage/Cloudflare work in the dirty tree; keep that out of the auth commit unless it becomes the requested task.

## Verification

- Passed focused auth package tests with the project Go toolchain:
  `go test ./internal/authentication ./internal/adapters/postgres ./internal/httpapi ./internal/config ./internal/adapters/password ./internal/adapters/google ./internal/adapters/redis ./internal/observability ./cmd`
- Full `apps/api/scripts/gate.sh` still needs to be run before handoff and may expose unrelated dirty-tree blockers.
