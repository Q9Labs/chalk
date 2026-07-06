# API Route, Service, Adapter, And Harness Map - 2026-07-06

## Top Level: Routes

### Domain: System And Operations

- `GET /healthz`
  - Handler: `httpapi.handleHealth`
  - Auth: public
  - Rate limit: none
  - Service/dependency: none
  - Harness: no scenario

- `GET /readyz`
  - Handler: `httpapi.handleReady`
  - Auth: public
  - Rate limit: none
  - Service/dependency: `httpapi.ReadinessChecker`
  - Main wiring: `postgres.Readiness{Pool: pool}`
  - Harness: no scenario

- `MOUNT /debug`
  - Handler: `options.Profiler`
  - Auth: public at router level, only mounted when `options.Profiler != nil`
  - Main wiring: `observability.Diagnostics.ApplyHTTP`, which only exposes profiler when configured by observability
  - Harness: no scenario

### Domain: Auth And Current User

- `POST /v1/auth/register`
  - Handler: `handleRegister`
  - Auth: public
  - Rate limit: `auth.register`, 5/minute by IP unless a principal is present
  - Service call: `AuthenticationService.Register`
  - Response behavior: sets `chalk_session` cookie and returns auth result
  - Harness: no scenario

- `POST /v1/auth/login`
  - Handler: `handleLogin`
  - Auth: public
  - Rate limit: `auth.login`, 10/minute by IP unless a principal is present
  - Service call: `AuthenticationService.Login`
  - Response behavior: sets `chalk_session` cookie and returns auth result
  - Harness: no scenario

- `GET /v1/auth/google/start`
  - Handler: `handleGoogleStart`
  - Auth: public
  - Rate limit: `auth.oauth.start`, 20/minute by IP unless a principal is present
  - Service call: `AuthenticationService.StartGoogleSignIn`
  - Response behavior: redirects to provider auth URL
  - Harness: no scenario

- `GET /v1/auth/google/callback`
  - Handler: `handleGoogleCallback`
  - Auth: public
  - Rate limit: `auth.oauth.callback`, 30/minute by IP unless a principal is present
  - Service call: `AuthenticationService.CompleteGoogleSignIn`
  - Response behavior: sets `chalk_session` cookie and returns auth result
  - Harness: no scenario

- `POST /v1/auth/logout`
  - Handler: `handleLogout`
  - Auth: `requireAuthentication`
  - Rate limit: none
  - Service call: `AuthenticationService.Logout`
  - Response behavior: clears `chalk_session` cookie
  - Harness: no scenario

- `GET /v1/me`
  - Handler: `handleMe`
  - Auth: `requireAuthentication`
  - Rate limit: `auth.me`, 100/minute by authenticated principal
  - Service call: none after middleware; reads `authentication.SessionUser` from request context
  - Harness: no scenario

### Domain: Tenants And Regions

- `POST /v1/tenants`
  - Handler: `handleCreateTenant`
  - Auth: protected group via `requireAuthentication`
  - Authorization: no tenant policy, because the tenant is being created
  - Rate limit: `v1.authenticated.write`, 60/minute by authenticated principal
  - Service call: `TenantService.CreateTenant`
  - Harness: `tenant-create`, passing, text and JSON verified

- `GET /v1/tenants`
  - Handler: `handleListTenants`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeGlobalReadRequest`, requires `PrincipalSystem`
  - Rate limit: none
  - Service call: `TenantService.ListTenants`
  - Harness: no scenario

- `GET /v1/tenants/{tenant_id}`
  - Handler: `handleGetTenant`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeTenantRequest` with `tenants:read` and minimum role `viewer`
  - Rate limit: none
  - Service call: `TenantService.GetTenant`
  - Harness: no scenario

- `PATCH /v1/tenants/{tenant_id}`
  - Handler: `handleUpdateTenant`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeTenantRequest` with `tenants:write` and minimum role `admin`
  - Rate limit: `v1.authenticated.write`, 60/minute by authenticated principal
  - Service call: `TenantService.UpdateTenant`
  - Harness: no scenario

- `GET /v1/regions`
  - Handler: `handleListRegions`
  - Auth: protected group via `requireAuthentication`
  - Authorization: none beyond authentication
  - Rate limit: none
  - Service call: `TenantService.AvailableRegions`
  - Harness: no scenario

### Domain: Users

- `POST /v1/users`
  - Handler: `handleCreateUser`
  - Auth: protected group via `requireAuthentication`
  - Authorization: none beyond authentication
  - Rate limit: `v1.authenticated.write`, 60/minute by authenticated principal
  - Service call: `UserService.CreateUser`
  - Harness: no scenario

- `GET /v1/users`
  - Handler: `handleListUsers`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeGlobalReadRequest`, requires `PrincipalSystem`
  - Rate limit: none
  - Service call: `UserService.ListUsers`
  - Harness: no scenario

- `GET /v1/users/{user_id}`
  - Handler: `handleGetUser`
  - Auth: protected group via `requireAuthentication`
  - Authorization: none beyond authentication
  - Rate limit: none
  - Service call: `UserService.GetUser`
  - Harness: no scenario

### Domain: Memberships

- `POST /v1/tenants/{tenant_id}/memberships`
  - Handler: `handleCreateMembership`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeTenantRequest` with `memberships:write` and minimum role `owner`
  - Rate limit: `v1.authenticated.write`, 60/minute by authenticated principal
  - Service call: `MembershipService.CreateMembership`
  - Harness: no scenario

- `GET /v1/tenants/{tenant_id}/memberships`
  - Handler: `handleListTenantMemberships`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeTenantRequest` with `memberships:read` and minimum role `viewer`
  - Rate limit: none
  - Service call: `MembershipService.ListTenantMemberships`
  - Harness: no scenario

- `PATCH /v1/tenants/{tenant_id}/memberships/{membership_id}`
  - Handler: `handleUpdateTenantMembership`
  - Auth: protected group via `requireAuthentication`
  - Authorization: `authorizeTenantRequest` with `memberships:write` and minimum role `owner`
  - Rate limit: `v1.authenticated.write`, 60/minute by authenticated principal
  - Service call: `MembershipService.UpdateTenantMembership`
  - Harness: no scenario

## Top Level: Services

### Domain: Authentication

- `authentication.Service.Register`
  - Validates/canonicalizes name, email, password; hashes password; creates password user; creates session
  - Ports: `authentication.Repository`, `PasswordHasher`
  - Adapters in main: `postgres.AuthenticationRepository`, `password.BcryptHasher`
  - HTTP routes: `POST /v1/auth/register`
  - Harness: no scenario

- `authentication.Service.Login`
  - Canonicalizes email; loads password identity; compares password; creates session
  - Ports: `authentication.Repository`, `PasswordHasher`
  - Adapters in main: `postgres.AuthenticationRepository`, `password.BcryptHasher`
  - HTTP routes: `POST /v1/auth/login`
  - Harness: no scenario

- `authentication.Service.AuthenticateSession`
  - Hashes raw token; loads active session/user
  - Ports: `authentication.Repository`
  - HTTP routes: all `requireAuthentication` protected routes
  - Harness: traced double only in `tenant-create`

- `authentication.Service.PrincipalForSession`
  - Converts session into request principal
  - HTTP routes: all `requireAuthentication` protected routes
  - Harness: traced double only in `tenant-create`

- `authentication.Service.Logout`
  - Revokes current session
  - Ports: `authentication.Repository`
  - HTTP routes: `POST /v1/auth/logout`
  - Harness: no scenario

- `authentication.Service.StartGoogleSignIn`
  - Creates OAuth state/verifier; stores verifier; returns provider URL
  - Ports: `GoogleProvider`, `OAuthStateStore`
  - Adapters in main when configured: `google.Provider`, `redis.OAuthStateStore`
  - HTTP routes: `GET /v1/auth/google/start`
  - Harness: no scenario

- `authentication.Service.CompleteGoogleSignIn`
  - Loads verifier, authenticates with Google, creates or finds user, creates session
  - Ports: `GoogleProvider`, `OAuthStateStore`, `authentication.Repository`
  - HTTP routes: `GET /v1/auth/google/callback`
  - Harness: no scenario

### Domain: Authorization

- `authorization.TenantPolicy.AuthorizeTenant`
  - Allows system principals; checks API-key scopes; checks user membership and minimum role
  - Port: `TenantMembershipReader`
  - Adapter in main: `postgres.MembershipRepository`
  - HTTP routes: tenant get/update and membership create/list/update
  - Harness: no scenario

- `authorization.RoleAllows`
  - Role hierarchy helper
  - HTTP routes: indirect through tenant policy
  - Harness: no scenario

### Domain: Tenants

- `tenants.Service.CreateTenant`
  - Validates/generates ID, trims required name, validates nullable fields and region, writes repository
  - Port: `tenants.TenantRepository`
  - Adapter in main: `postgres.TenantRepository`
  - HTTP route: `POST /v1/tenants`
  - Harness: `tenant-create`

- `tenants.Service.GetTenant`
  - Validates ID, reads repository
  - HTTP route: `GET /v1/tenants/{tenant_id}`
  - Harness: no scenario

- `tenants.Service.ListTenants`
  - Reads paginated repository
  - HTTP route: `GET /v1/tenants`
  - Harness: no scenario

- `tenants.Service.UpdateTenant`
  - Validates ID and optional nullable fields, writes repository
  - HTTP route: `PATCH /v1/tenants/{tenant_id}`
  - Harness: no scenario

- `tenants.Service.AvailableRegions`
  - Returns static `regions.Available`
  - HTTP route: `GET /v1/regions`
  - Harness: no scenario

### Domain: Users

- `users.Service.CreateUser`
  - Validates/generates ID, trims name/email, writes repository
  - Port: `users.UserRepository`
  - Adapter in main: `postgres.UserRepository`
  - HTTP route: `POST /v1/users`
  - Harness: no scenario

- `users.Service.GetUser`
  - Validates ID, reads repository
  - HTTP route: `GET /v1/users/{user_id}`
  - Harness: no scenario

- `users.Service.ListUsers`
  - Reads paginated repository
  - HTTP route: `GET /v1/users`
  - Harness: no scenario

### Domain: Memberships

- `memberships.Service.CreateMembership`
  - Validates/generates ID, tenant ID, user ID, role, writes repository
  - Port: `memberships.MembershipRepository`
  - Adapter in main: `postgres.MembershipRepository`
  - HTTP route: `POST /v1/tenants/{tenant_id}/memberships`
  - Harness: no scenario

- `memberships.Service.GetTenantMembershipForUser`
  - Validates tenant/user IDs, reads repository
  - Consumer: `authorization.TenantPolicy`
  - Harness: no scenario

- `memberships.Service.ListTenantMemberships`
  - Validates tenant ID, reads paginated repository
  - HTTP route: `GET /v1/tenants/{tenant_id}/memberships`
  - Harness: no scenario

- `memberships.Service.UpdateTenantMembership`
  - Validates tenant ID, membership ID, role, writes repository
  - HTTP route: `PATCH /v1/tenants/{tenant_id}/memberships/{membership_id}`
  - Harness: no scenario

### Domain: Media Plane

- `mediaplane.Service.EnsureSession`
  - Validates provider/session key/title/metadata, delegates to media plane port
  - Port: `mediaplane.Plane`
  - Adapters available: `cloudflare/rtk.Plane`, `cloudflare/sfu.Adapter`
  - HTTP route: not mounted
  - Main wiring: not wired
  - Harness: no scenario

- `mediaplane.Service.CreateJoin`
  - Validates provider/session/participant fields, delegates to media plane port
  - HTTP route: not mounted
  - Harness: no scenario

- `mediaplane.Service.RemoveParticipant`
  - Validates provider/session ref/participant ref, delegates
  - HTTP route: not mounted
  - Harness: no scenario

- `mediaplane.Service.EndSession`
  - Validates provider/session ref, delegates
  - HTTP route: not mounted
  - Harness: no scenario

- `mediaplane.Service.SessionUsage`
  - Validates provider/session ref, delegates
  - HTTP route: not mounted
  - Harness: no scenario

### Domain: Object Storage

- `objectstorage.Service.PutObject`
  - Validates key/body/content type/length/metadata, delegates to store
  - Port: `objectstorage.Store`
  - Adapter available: `cloudflare/r2.Store`
  - HTTP route: not mounted
  - Main wiring: not wired
  - Harness: no scenario

- `objectstorage.Service.GetObject`
  - Validates key, delegates to store
  - HTTP route: not mounted
  - Harness: no scenario

- `objectstorage.Service.DeleteObject`
  - Validates key, delegates to store
  - HTTP route: not mounted
  - Harness: no scenario

- `objectstorage.Service.CreateUploadURL`
  - Validates key/content type/expiration, delegates to store
  - HTTP route: not mounted
  - Harness: no scenario

- `objectstorage.Service.CreateDownloadURL`
  - Validates key/expiration, delegates to store
  - HTTP route: not mounted
  - Harness: no scenario

### Domain: Email

- `email.Service.SendEmail`
  - Validates sender, recipients, subject, body, tags, and delegates
  - Port: `email.Sender`
  - Adapter available: `resend.Sender`
  - HTTP route: not mounted
  - Main wiring: not wired
  - Harness: no scenario

### Domain: Rate Limit

- `ratelimit.LocalLimiter.Allow`
  - Local token bucket limiter
  - HTTP consumer: `httpapi.rateLimit`
  - Adapter alternative: `redis.RateLimiter` in non-local environments
  - Harness: no scenario

- `ratelimit.RetryAfter`
  - Computes retry delay for denied requests
  - HTTP consumer: `httpapi.writeRateLimited`
  - Harness: no scenario

### Domain: Pagination, Regions, Utilities, Config, Observability

- `pagination.NewPageRequest`, `EncodeCursor`, `DecodeCursor`
  - HTTP consumers: list tenants/users/memberships
  - Harness: no scenario

- `regions.Available`, `Contains`
  - Consumers: tenant validation and `GET /v1/regions`
  - Harness: no scenario

- `utilities.ID`, `RequiredString`, `NullableString`, `OptionalNullableString`, `FormatTimestamp`
  - Consumers: most services and HTTP DTOs
  - Harness: partial through `tenant-create`

- `config.Load`
  - Consumer: `cmd/main.go`
  - Harness: no scenario

- `observability.Diagnostics`
  - Consumers: `cmd/main.go` for logger, query instrumentation, HTTP middleware/profiler
  - Harness: no scenario

## Top Level: Adapters

### Domain: Postgres

- `postgres.Open` / `PoolConfig`
  - Config: `config.DatabaseConfig`
  - Main wiring: opens API Postgres pool
  - Harness: no scenario

- `postgres.Readiness.Check`
  - Route: `GET /readyz`
  - Harness: no scenario

- `postgres.AuthenticationRepository`
  - Implements `authentication.Repository`
  - SQLC calls: auth identities, users, sessions
  - Main wiring: authentication service
  - Harness: no scenario

- `postgres.TenantRepository`
  - Implements `tenants.TenantRepository`
  - SQLC calls: tenants
  - Main wiring: tenant service
  - Harness: represented by traced double in `tenant-create`, not real Postgres

- `postgres.UserRepository`
  - Implements `users.UserRepository`
  - SQLC calls: users
  - Main wiring: user service
  - Harness: no scenario

- `postgres.MembershipRepository`
  - Implements `memberships.MembershipRepository` and `authorization.TenantMembershipReader`
  - SQLC calls: memberships
  - Main wiring: membership service and tenant policy
  - Harness: no scenario

### Domain: Redis

- `redis.Open`
  - Config: Redis URL
  - Main wiring: OAuth state when Google configured, and rate limits outside local
  - Harness: no scenario

- `redis.OAuthStateStore`
  - Implements `authentication.OAuthStateStore`
  - Main wiring: Google OAuth flow when configured
  - Harness: no scenario

- `redis.RateLimiter`
  - Implements `ratelimit.Limiter`
  - Main wiring: non-local HTTP rate limiting
  - Harness: no scenario

### Domain: Password

- `password.BcryptHasher`
  - Implements `authentication.PasswordHasher`
  - Main wiring: authentication service
  - Harness: no scenario

### Domain: Google

- `google.Provider`
  - Implements `authentication.GoogleProvider`
  - Main wiring: Google OAuth when configured
  - Harness: no scenario

### Domain: Cloudflare

- `cloudflare/r2.Store`
  - Implements `objectstorage.Store`
  - Main wiring: not wired
  - Harness: no scenario

- `cloudflare/rtk.Plane`
  - Implements `mediaplane.Plane`
  - Main wiring: not wired
  - Harness: no scenario

- `cloudflare/sfu.Adapter`
  - Implements `mediaplane.Plane`
  - Extra method: `VerifySessionMetadata`
  - Main wiring: not wired
  - Harness: no scenario

### Domain: Resend

- `resend.Sender`
  - Implements `email.Sender`
  - Main wiring: not wired
  - Harness: no scenario

## Top Level: Cross-Cutting HTTP Concerns

### Domain: Authentication Middleware

- `requireAuthentication`
  - Reads bearer token first, then `chalk_session` cookie
  - Calls `AuthenticationService.AuthenticateSession`
  - Attaches `authentication.Principal` and `authentication.SessionUser` to context
  - Harness: traced through `tenant-create`

### Domain: Authorization Helpers

- `authorizeTenantRequest`
  - Requires `TenantAuthorizer`; maps policy errors to HTTP errors
  - Used by tenant item and membership routes
  - Harness: no scenario

- `authorizeGlobalReadRequest`
  - Requires `PrincipalSystem`
  - Used by global tenant and user list routes
  - Harness: no scenario

### Domain: Rate Limit Middleware

- `rateLimit`
  - Uses principal key when authenticated, otherwise client IP
  - Client IP uses remote address unless remote is in trusted proxy CIDRs, then checks `CF-Connecting-IP` and first valid `X-Forwarded-For`
  - Denial response: `429` with `Retry-After`
  - Harness: no scenario

### Domain: Request/Response Shape

- `decodeRequest`
  - JSON body decode helper used by body-bearing routes
  - Harness: partial through `tenant-create`

- `writeJSON`, `writeError`
  - Shared JSON success/error response helpers
  - Harness: partial through `tenant-create`

- Pagination helpers
  - `parsePageRequest`, `newPaginationResponse`, `writePaginationError`
  - Used by list routes
  - Harness: no scenario

### Domain: CORS And Observability

- `allowCORS`
  - Router-level CORS middleware
  - Harness: not asserted

- `observability.RequestMiddleware`, `ProfilerHandler`, query wrappers
  - Applied from `cmd/main.go` based on config
  - Harness: no scenario

## Harness Run Status

- Implemented all planned scenario names listed below.
- Ran CLI text-mode sweep for every registered scenario:
  - Command shape: `go run ./cmd/trace -scenario <name> -color never`
  - Result: all registered scenarios passed through the CLI

- Ran `go run ./cmd/trace -scenario tenant-create -color never`
  - Result: pass, HTTP `201`

- Ran `go run ./cmd/trace -scenario tenant-create -format json`
  - Result: pass, HTTP `201`, JSON output valid

- Ran `go test ./internal/traceharness ./cmd/trace`
  - Result: pass

## Harness Coverage Gaps

- Registered scenario coverage now exists for every planned route/service/policy/ratelimit/adapter/edge item in this map.
- The traces keep real router/service/policy validation in the path and use traced local doubles at database/provider boundaries.
- Remaining non-goals: the adapter-family scenarios show provider-shaped operations with traced local doubles; they do not call live Postgres, Redis, Cloudflare, R2, or Resend services.

## Implemented Scenario Family

- `route:auth-register`
- `route:auth-login`
- `route:auth-logout`
- `route:auth-google-start`
- `route:auth-google-callback`
- `route:me`
- `route:tenant-create` or keep legacy `tenant-create`
- `route:tenant-list-system`
- `route:tenant-get-authorized`
- `route:tenant-update-authorized`
- `route:regions-list`
- `route:user-create`
- `route:user-list-system`
- `route:user-get`
- `route:membership-create-owner`
- `route:membership-list-viewer`
- `route:membership-update-owner`
- `policy:tenant-system-allow`
- `policy:tenant-api-key-scope`
- `policy:tenant-user-role`
- `ratelimit:ip-deny`
- `ratelimit:principal-deny`
- `adapter:postgres-tenant-create`
- `adapter:redis-rate-limit`
- `adapter:cloudflare-r2-signed-url`
- `adapter:cloudflare-sfu-bootstrap`
- `adapter:cloudflare-rtk-join`
- `adapter:resend-send-email`
- `edge:unauthenticated-route`
- `edge:forbidden-tenant-route`
- `edge:invalid-route-id`
