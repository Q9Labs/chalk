# Go API Code Standards

These are local standards for `apps/api`. They capture the code-shape choices
we want future work to preserve.

## Naming

- Prefer domain-shaped names over method-shaped names. For example, HTTP should
  depend on `TenantService`, not `TenantGetter`.
- Use `Service` for business/use-case behavior and `Repository` for persistence
  adapters.
- Be picky about names. A weak name is a design smell; rename it before the
  pattern spreads.
- Avoid vague prefixes such as `normalize`. Name helpers after the decision they
  make or the boundary they cross.

### No Stutter

- Inside a single-resource package, the core types are `Service`, `Repository`,
  and `Config` — never `TenantService`, `TenantRepository`, `UserRepository`.
  The package already carries the noun; `tenants.Repository` reads, `tenants.TenantRepository`
  stutters. `authentication.Repository` is the model to copy.
- The exception is a consumer-defined interface that lives in a package named
  for a different concern. `httpapi.TenantService` is correctly qualified because
  there the qualifier is what disambiguates several services in one package.
- Method names on a single-resource `Service`/`Repository` do not repeat the
  resource: prefer `Create`/`Get`/`List`/`Update` over `CreateTenant`/`GetTenant`
  when the package and receiver already say it.

### Verbs And Nouns

- Types and interfaces are nouns; functions and methods are verbs. A method named
  for its return type (`input()`, `config()`) is a smell — name the action
  (`toCreateUserInput`, `serviceInput`).
- Keep verb families consistent so a reader learns them once: `handle*` for HTTP
  handlers, `mount*Routes` for routing, `new*Response` for response DTO builders,
  `write*` for response writers, `Start*`/`Complete*` for multi-step flows.
- Cross-cutting initialisms stay fully cased: `API`, `URL`, `ID`, `OAuth`,
  `HTTP` — `APIKeyID`, `AuthorizationURL`, not `ApiKeyId` or `AuthorizationUrl`.

### Ports And Their Adapters

- A port is named in domain language (`objectstorage.Store`, `email.Sender`,
  `mediaplane.Plane`). An adapter that implements it does not reuse the port's
  name — every adapter for a given port shares one predictable type name
  (`Adapter`) and constructor shape (`NewAdapter` / `NewAdapterWithClient`), so
  two implementations of the same port read as peers.
- Adapter packages are named for the product or protocol a newcomer recognizes,
  spelled out — `realtimekit`, not `rtk`; name what the adapter integrates with,
  not an internal category abbreviation. A vendor's real product name (`r2`) is
  fine; an insider acronym is not.
- One config type serves one provider. If two adapters integrate different
  services, they take different config types even when both are the same vendor;
  a shared config name across distinct integrations hides that they differ.

### Errors And Shared Concepts

- The same failure has one error name across the codebase. `ErrInvalidEmail` and
  `ErrInvalidUserEmail` for the same validation is a duplicated-rule symptom —
  collapse the rule and the name collapses with it.
- Do not name a package `utilities`, `utils`, `common`, or `helpers`. A package
  name should describe what is inside; group primitives by concept (`id`,
  `nullable`) so the import path carries meaning. A grab-bag package becomes a
  junk drawer of unrelated code.
- Keep one vocabulary per concept. If the package is `observability`, its
  constructor should not hand back a `Diagnostics` — pick the word and use it for
  the package, the type, and the file.
- Avoid local variable names that shadow standard-library packages (`bytes`,
  `time`, `url`); the shadow reads as a subtle mistake even when it is harmless.

## File Shape

- Put package-level errors, vars, constants, interfaces, and types near the top
  of the file.
- Put logic/functions after the definitions they operate on.
- Avoid alternating `types -> functions -> more types -> more functions` unless
  the file is generated or there is a strong local reason.

## Boundaries

- Keep `cmd/main.go` as the composition root. It should wire config, adapters,
  services, router, and lifecycle, not own domain behavior.
- Keep each API slice's chain explicit:
  `HTTP route -> service interface -> service -> repository interface -> Postgres adapter -> sqlc query`.
- HTTP handlers translate transport concerns into service inputs. Business
  decisions belong in services; database-driver details belong in adapters.
- Parse and validate request-shaped data as close to the HTTP edge as practical.
  Fail early before doing service or database work.
- Keep domain/service packages free of database-driver types such as `pgtype`.
  Translate those types in Postgres adapters only.
- Prefer reusable shared types for cross-cutting concepts such as IDs and
  optional JSON fields instead of redefining them per domain.
- API nullable fields should encode as JSON `null`, not empty strings.

## Authentication And Authorization

- Every `/v1` route is authenticated unless it is deliberately public (health,
  readiness, the auth/login/register/OAuth handlers). Mount protected routes
  under a group that applies `requireAuthentication`; do not attach a protected
  handler directly. New route groups default to protected.
- Authenticating the caller is not authorizing the request. After you know _who_
  is calling, check _what_ they may touch. For any tenant-scoped resource, call
  `authorization.TenantPolicy.AuthorizeTenant` with the principal, the tenant ID
  from the request, and the required permission before doing any read or write.
- Never trust an ID from the URL or body as proof of access. A handler that
  reads `tenant_id` from the path must verify the principal's membership in that
  tenant, or the endpoint is an IDOR.
- Global, cross-tenant reads (platform-admin listings such as `ListUsers`,
  `ListTenants`) must be gated so a tenant-scoped principal can never reach them.
  Treat any query without a tenant filter as privileged.
- A protected route is not done until a test asserts that an anonymous request
  gets `401` and an unauthorized-but-authenticated request gets `403`. If the
  suite passes without those cases, the suite cannot catch a missing guard.

## Request Hardening

- Bound every request body. Wrap `r.Body` in `http.MaxBytesReader` before
  decoding; unbounded JSON is a memory-exhaustion DoS.
- The HTTP server sets `ReadTimeout`, `WriteTimeout`, `IdleTimeout`, and
  `MaxHeaderBytes`, not only `ReadHeaderTimeout`. Missing body/write timeouts
  leave the server open to slow-client connection exhaustion.
- Rate-limit credential endpoints (`/auth/login`, `/auth/register`) and anything
  that can be probed for existence. Keep failure responses generic so they do not
  become enumeration oracles.
- Enforce security invariants in the query as well as the service when the cost
  is low (for example, filter expired and revoked sessions in SQL, not only in
  the service). Defense in depth survives refactors that drop a caller-side check.

## Secure Defaults

- Config defaults are safe to ship, or the app refuses to start. Do not default
  to plaintext transport, shared credentials, or `sslmode=disable` and rely on
  the operator to override. Require TLS and real secrets outside `local`, and
  fail fast when they are missing rather than booting insecurely.
- Debug and profiling surfaces (`/debug/pprof`) are never reachable in a
  non-local environment. Gate them on `Environment == "local"` in addition to any
  feature flag; a single flag that an operator can flip in prod is not a guard.
- Escape or constrain any caller-influenced value before interpolating it into an
  outbound URL, path, or provider request. `requiredString`-style trimming is not
  validation; use `url.PathEscape` or a strict charset check.

## One Concept, One Implementation

- A validation or normalization rule (email canonicalization, ID parsing, required
  strings) has exactly one implementation. If two packages need the same rule, one
  calls the other or both call a shared helper — they do not each re-derive a
  weaker or stricter variant.
- Before writing a small helper, grep for an existing one. Duplicating
  `utilities.RequiredString` (or any shared primitive) with a local copy is a
  defect, not a convenience.
- Route repeated edge concerns through a shared helper rather than re-spelling
  them. Nil-service guards, error-to-HTTP mapping, and route-ID parsing should
  look identical across sibling handler files, or be dropped where they are dead.

## Shipping Foundations

- Do not merge tested-but-unwired subsystems to `master`. Code that no non-test
  file imports reads as "handled" and hides gaps (an authorization engine that is
  never invoked looks done but protects nothing). Wire a subsystem behind the
  endpoint that consumes it in the same change, or keep it on a feature branch
  until that endpoint lands.
- The first implementation establishes only the shape the current consumer needs.
  Unused enum values, principal kinds, and scopes are premature until a caller
  exercises them.

## Ports And Adapters

- Core packages define provider-neutral ports in domain language. For example,
  use `objectstorage.Store` instead of an R2- or S3-shaped interface.
- Adapter packages own provider SDK types, credential/config translation,
  provider-specific request/response mapping, and provider error translation.
- Provider-specific IDs, headers, regions, endpoints, and SDK errors should not
  leak into core packages, HTTP contracts, or durable schema.
- The first adapter for a port should establish only the shape the current port
  needs. Do not generalize for future providers until a second implementation
  proves the abstraction.
- Avoid speculative helper seams. A helper should encode a real boundary or
  decision, not just forward to another helper with a different noun.
- Test service/port validation separately from provider adapter mapping so
  product rules and SDK translation failures are easy to review independently.

## Comments

- Add comments when they explain why a boundary, invariant, workaround, or
  non-obvious tradeoff exists.
- Avoid comments that merely restate what the code says.
- Treat a needed explanatory comment as a design checkpoint: if the comment
  reveals duplication, hidden coupling, or an awkward abstraction, improve the
  shape or leave a concise note about the constraint.

## Utilities

- Put small cross-domain primitives such as IDs and reusable string/nullable
  field helpers under `internal/utilities` until they grow enough domain weight
  to deserve a narrower package.
- Shared utilities should earn their place by removing real duplication or
  preserving a boundary. Do not create generic helpers just because two lines
  look similar.
- Adapter helpers should make crossing a boundary explicit. If a helper converts
  domain values into Postgres values, keep it in the Postgres adapter unless
  multiple adapters need it.
- Repository adapters should depend on tiny local query interfaces instead of
  the full generated `db.Querier`, so unrelated sqlc additions do not break
  focused tests.
