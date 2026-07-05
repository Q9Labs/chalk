# Security & Code Quality Review — 2026-07-03

Scope: `apps/api` (~14k LOC, Go). Reviewed the HTTP edge, authentication /
authorization, the Postgres/data layer, the Cloudflare + Resend adapters, config
/ observability, and overall structure. `go build`, `go vet`, and `go test ./...`
all pass at time of review.

## TL;DR

The architecture is sound — clean ports-and-adapters, idiomatic Go, consistent
service shapes. There is **one critical, actively-exploitable hole**: the
`/v1/tenants`, `/v1/users`, and `/v1/memberships` route trees have no
authentication and no authorization. Anyone on the internet can list every
user's email, read/modify any tenant, and grant themselves ownership of any
tenant. A complete authorization engine (`internal/authorization`) exists, is
unit-tested, and is wired into nothing. Fixing that is job #1; the rest is
hardening and cleanup.

---

## Security findings

### Critical

**C1 — Tenant/user/membership endpoints are fully public.**
`internal/httpapi/router.go` (`mountTenantRoutes` / `mountUserRoutes` /
`mountMembershipRoutes`) attach handlers with no middleware. `requireAuthentication`
is applied to exactly two routes: `/me` (`me.go:10`) and `/auth/logout`
(`auth.go:59`). The handlers never inspect the caller's principal. All
unauthenticated:

- `GET /v1/users` dumps every user record including email addresses (PII breach /
  enumeration).
- `GET/POST/PATCH /v1/tenants/{id}` — read and modify any tenant.
- `POST /v1/tenants/{id}/memberships` — an attacker adds their own user with
  `owner` role to any tenant, then owns it.

`internal/authorization` (`TenantPolicy.AuthorizeTenant`, `RoleAllows`) is
imported by nothing outside its own tests. The policy engine and the route
mounting were built in separate commits and never joined.

**Fix:** wrap the `/v1` resource routes in `requireAuthentication`, then call
`AuthorizeTenant(ctx, principal, tenantID, permission)` inside each tenant-scoped
handler/service. The `PrincipalFromContext` plumbing already exists to feed it.

### High

**H1 — No object-level authorization even once authenticated (IDOR).** Handlers
take `tenant_id` / `user_id` straight from the URL and pass them to the service
with no check that the principal belongs to that tenant. A bare auth middleware
alone would still let any logged-in user reach any tenant. C1's real fix (the
per-tenant membership check) closes this — treat them as one workstream.

**H2 — pprof exposed without auth when enabled.** `internal/observability/profiler.go`
mounts the full `/debug/pprof/*` suite behind no auth. `/heap` and `/goroutine`
can leak in-memory secrets/PII; `/profile` is a trivial 30s-CPU DoS lever. Gated
by `CHALK_API_PROFILER` (default false), so the risk is "someone sets the flag in
prod" — and `cmd/perf/main.go` sets that flag, normalizing it. Add a second guard:
refuse to mount unless `Environment == "local"`, or put it behind auth / an admin
listener.

### Medium

**M1 — No request body size limit.** `internal/httpapi/request.go` wraps `r.Body`
in a JSON decoder with no `http.MaxBytesReader`. Any POST/PATCH can ship an
arbitrarily large body → unbounded memory. (`DisallowUnknownFields` is correctly
set.) One-line fix in `decodeRequest`.

**M2 — Missing server timeouts.** `cmd/main.go` sets only `ReadHeaderTimeout`. No
`ReadTimeout` / `WriteTimeout` / `IdleTimeout` / `MaxHeaderBytes` means a
slow-body or slow-read client pins connections/goroutines indefinitely (slowloris
variants).

**M3 — No rate limiting on `/auth/login` and `/auth/register`.** Login correctly
returns a generic `invalid_credentials`, but nothing throttles brute-force /
credential stuffing. Register returns `409 email_already_registered`, an
enumeration oracle (becomes the only one once C1 is fixed).

**M4 — Insecure DB default with no production guardrail.** `internal/config/config.go:59`
— `DefaultDatabaseURL` hard-codes `postgres:postgres` and `sslmode=disable`,
applied unconditionally with no check that non-local envs supply a TLS DSN. A
missing/misspelled `CHALK_DATABASE_URL` in prod silently boots against an
unencrypted connection. bcrypt hashes and session-token hashes then cross the
network in cleartext. Require `sslmode=require`+ outside local.

**M5 — Provider URL path injection in the media plane.** `internal/adapters/cloudflare/rtk/plane.go:214-228`
and `sfu/adapter.go:138` interpolate `SessionRef` / `ParticipantRef` into
Cloudflare API URLs via `fmt.Sprintf`. Their only validation
(`mediaplane.requiredString`) just trims whitespace — it doesn't reject `/`, `..`,
`?`, `#`. A crafted ref like `../../meetings/OTHER/participants/ID` redirects the
authenticated request to a different resource in the account. Not reachable today
(media plane is unwired); fix before wiring with `url.PathEscape` or a safe-charset
constraint.

### Low (defense-in-depth / notes)

- **Session query doesn't filter expired/revoked rows**
  (`sqlc/authentication.sql.go` `GetLoginSessionByTokenHash`). The service layer
  does check it (`authentication/service.go:711-714`), so this is defense-in-depth:
  add `expires_at > now() AND revoked_at IS NULL` to the query so a refactor can't
  silently drop it.
- **bcrypt 72-byte truncation** (`password/bcrypt.go`) — standard, but no SHA-256
  pre-hash; passwords sharing the first 72 bytes are interchangeable. Cost is 10;
  consider 12.
- **Missing FK indexes** on `auth_identities.user_id` and `login_sessions.user_id`
  (`db/schema.sql`) — per-user session revocation is a seq scan as the table grows.
- **CSRF rests solely on `SameSite=Lax`** — adequate today (credentialed CORS is
  never enabled), but incidental. A future move to `SameSite=None` or credentialed
  CORS opens it. The session token is also echoed in the JSON body (fine for Bearer
  clients, defeats HttpOnly if an SPA stores it — confirm intent).
- **Resend client skips the `Timeout > 0` guard** its R2/RTK siblings have
  (`resend/sender.go:32`); config defaults it, so latent only.

### Verified clean

No SQL injection (sqlc, fully parameterized); Google OIDC properly validates
signature / issuer / audience and `email_verified`, with correct PKCE; Redis
OAuth state is atomic single-use (`GetDel`); UUIDv4 IDs use `crypto/rand`;
pagination size is hard-capped at 100; no secrets logged; graceful shutdown is
correct.

---

## Code quality & structure

The bones are strong: consumer-defined port interfaces with compile-time
`var _ Interface = impl{}` assertions, dependencies flowing strictly inward,
`pgtype` confined to the Postgres adapter, four near-identically-shaped CRUD
services. `utilities.OptionalString`'s three-state PATCH handling and the
`observability.Queries` decorator over the sqlc `Querier` are particularly well
done. Keep those.

Patterns worth changing:

| #   | Current pattern                                                                                                                                                                                                                   | Why it's a problem                                                                                                                               | Better pattern                                                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 1   | Large tested-but-unwired subsystems on `master`: `authorization`, `mediaplane`, `objectstorage`, `email`, all cloudflare/resend adapters, `Principal.{APIKeyID,TenantID,Scopes}`, all 27 `Scope` constants — imported by nothing. | Contradicts "no premature abstractions" and hides C1 (the authz engine looks done but isn't connected). Dead-but-tested code reads as "handled." | Wire each behind the endpoint that needs it, or keep it on a feature branch until the consuming feature lands.                |
| 2   | Two email normalizers: `authentication.CanonicalEmail` does strict `mail.ParseAddress`; `users.prepareEmail` (`users/service.go:95`) only checks for `@`.                                                                         | A user created via `POST /v1/users` can hold an email `authentication` would reject — split-brain invariant.                                     | Single-source it: `users` calls `authentication.CanonicalEmail`, or factor one canonicalizer into `utilities`.                |
| 3   | `authentication/service.go` is 482 lines mixing orchestration, DTOs, and stateless crypto helpers.                                                                                                                                | Exceeds the 300-line standard; policy and orchestration are entangled.                                                                           | Split helpers (`CanonicalEmail`, `PreparePassword`, `SessionTokenHash`, `randomURLToken`) into `credentials.go` + `token.go`. |
| 4   | `mediaplane.requiredString` is a verbatim copy of `utilities.RequiredString` (`mediaplane/service.go:270`).                                                                                                                       | Pure duplication, even re-creating the error value.                                                                                              | Inline the utility. (`objectstorage`'s key/content-type helpers are genuinely domain-specific — leave those.)                 |
| 5   | Repeated `if service == nil` guards, longhand in tenants/users/memberships but factored into `writeServiceUnavailable` in auth; same as the per-method `s.plane == nil` guards in mediaplane.                                     | Same guard, two spellings; and per "no unnecessary defensive checks" these are dead (services are always constructed in `main.go`).              | Drop them, or route all through the existing helper.                                                                          |
| 6   | Missing adapter tests for `postgres/users.go` and `postgres/memberships.go` (siblings have them).                                                                                                                                 | The sqlc param-mapping and `ErrNoRows→ErrNotFound` translation — exactly what adapter tests catch — is unverified.                               | Add `users_test.go` / `memberships_test.go` using the existing querier-mock pattern.                                          |
| 7   | Test blind spot: `router_test.go`'s 401 assertions cover only `/me` and `/logout`; tenant/user/membership tests expect success and never assert anonymous rejection.                                                              | This is why C1 shipped green — the suite structurally can't catch missing auth.                                                                  | Add "anonymous request → 401" cases for every protected route.                                                                |

Lower-priority style notes: the four near-duplicate `writeXServiceError`
`errors.Is` ladders could collapse into one table-driven mapper (~60 fewer lines);
`router_test.go` at 1441 lines could split per-resource.

---

## Suggested order of work

1. **C1 + H1 together** — protect `/v1` routes with `requireAuthentication` and
   wire `TenantPolicy.AuthorizeTenant` into the tenant-scoped handlers; add the
   anonymous-rejection tests (#7). This is the whole ballgame.
2. **M1 + M2 + M3** — body-size limit, server timeouts, auth rate limiting.
3. **M4** — reject insecure/plaintext DB DSN outside local; **H2** — env-guard
   pprof.
4. **Cleanup** — dedup email normalization (#2), split the 482-line auth file
   (#3), add the missing adapter tests (#6), then the rest.
