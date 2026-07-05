# Authentication Plan

This plan is for the next API foundation slice: core authentication. It does
not include external Google service grants such as Calendar, Drive, Gmail,
Meet, Gemini, or NotebookLM access.

## Goal

Build the smallest solid auth chain:

```text
email/password or Google sign-in -> Chalk session -> Principal -> protected API route
```

The first useful proof is an authenticated route such as `GET /v1/me` that
loads the current user from a valid session.

## Slices

Implement these slices continuously rather than pausing between password auth
and Google sign-in, unless the code review reveals that the auth surface is
getting too large to assess safely.

### 1. Password Authentication

Add:

```http
POST /v1/auth/register
POST /v1/auth/login
```

The register/login response should return the raw session token once, its
expiry, and the user shape:

```json
{
  "session_token": "...",
  "expires_at": "2026-08-01T00:00:00Z",
  "user": {
    "id": "...",
    "email": "user@example.com",
    "name": "Hasan",
    "created_at": "2026-07-02T00:00:00Z",
    "updated_at": "2026-07-02T00:00:00Z"
  }
}
```

Use `golang.org/x/crypto/bcrypt` behind a password adapter with
`bcrypt.DefaultCost`. Trim surrounding password whitespace before validation and
hashing. Use a simple default policy: minimum 8 characters, maximum 72 bytes,
and no forced character-class rules. The maximum exists because bcrypt only uses
the first 72 bytes.

Login errors should be intentionally generic so we do not reveal whether an
email exists.

Email behavior:

- Trim surrounding whitespace.
- Lowercase before storing and comparing.
- Require syntactically valid email.
- Store the canonical lowercase email.
- Return `409 Conflict` with a stable error code when registering an email that
  already exists.

Email verification should be config-driven so local development and tests can
disable it without changing code.

### 2. Sessions And Middleware

Use `login_sessions` as the session store.

Session behavior:

- Generate a cryptographically random token.
- Store only a hash of the token in Postgres.
- Return the raw token only at creation time.
- Reject expired or revoked sessions.
- Support both `Authorization: Bearer <token>` and an HTTP-only session cookie
  named `chalk_session`.
- Load a `Principal` from either accepted session transport.

Session expiry should be config-driven and default to 30 days. Tests and local
development should be able to shorten it without changing code.

Session cookies should be `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure`
outside local development.

Add:

```http
POST /v1/auth/logout
GET  /v1/me
```

`GET /v1/me` is the proof route for the auth chain. It should require a valid
session and return the current user.

### 3. Google Sign-In

Add after password auth and session middleware are working:

```http
GET /v1/auth/google/start
GET /v1/auth/google/callback
```

Google sign-in should request only:

```text
openid email profile
```

The sign-in flow should verify the Google ID token, map Google `sub` to
`auth_identities.provider_subject`, then create a Chalk session.

Store short-lived OAuth state and PKCE verifier in Redis.

On first Google sign-in, auto-create the Chalk user. If the Google email already
belongs to an existing password user, do not link the accounts silently. Return
a clear conflict and add explicit account linking later.

## Boundaries

Suggested code shape:

```text
internal/authentication/
  service.go
  principal.go
  scopes.go
  context.go
  errors.go

internal/authorization/
  tenant.go

internal/adapters/postgres/
  authentication.go

internal/adapters/password/
  bcrypt.go

internal/adapters/google/
  oidc.go

internal/httpapi/
  auth.go
  middleware.go
  me.go
```

Keep this chain explicit:

```text
HTTP route -> authentication service -> repository interface -> Postgres adapter -> sqlc query
```

HTTP owns request parsing and transport-shaped validation. Services own auth
business rules. Adapters own bcrypt, Google, Redis, Postgres, and other
provider details.

Services should receive a `Principal` explicitly when authorization decisions
matter. Context can carry request-scoped plumbing, but it should not hide
business input.

## Data Model

Use existing core tables first:

- `users`
- `auth_identities`
- `login_sessions`

Password auth should store the password hash in `auth_identities.password_hash`.
Google sign-in should use `auth_identities.provider = 'google'` and
`provider_subject = Google sub`.

Session tokens should be stored only as hashes in `login_sessions`. Logout
should revoke only the current session; "logout all devices" can be added later.

Do not add `connected_accounts` yet. That table belongs to future integration
features where users grant Chalk access to external services such as Calendar,
Drive, Gmail, or Meet.

## Tests

Add focused tests for:

- Register success.
- Duplicate email.
- Login success.
- Wrong password.
- Password length boundaries.
- Session token is not stored raw.
- Middleware accepts a valid session.
- Middleware rejects missing, invalid, expired, and revoked sessions.
- `GET /v1/me` returns the authenticated user.

Run:

```bash
apps/api/scripts/gate.sh
```

## Deferred

Not part of this auth slice:

- Google Calendar, Meet, Drive, Gmail, Gemini, or NotebookLM access.
- OAuth refresh-token storage.
- Token encryption for external providers.
- Provider grant revocation.
- Background sync workers.
- `connected_accounts` or `provider_connections`.

Those are integration features and should be planned separately after core auth
is stable.
