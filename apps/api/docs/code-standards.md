# Go API conventions

## Names and packages

- Inside a domain package, use `Service`, `Repository`, and `Config`; qualify consumer-defined interfaces when needed, such as `httpapi.TenantService`.
- Use `Create`, `Get`, and `List` when the receiver already names the resource.
- Keep the existing HTTP helper names: `*Endpoint`, `decode*Request`, `mount*Routes`, `new*Response`, and `write*`.
- Provider adapters use `Adapter` and `NewAdapter` / `NewAdapterWithClient`. Name packages for the provider or protocol, and keep separate config types for separate integrations.
- Reuse existing ID/string/nullable primitives in `internal/utilities`; put new domain-specific helpers with their domain. Don't create another grab-bag package.

## API boundaries

`cmd/main.go` wires the app. The usual path is endpoint → service → repository → Postgres adapter → sqlc query. Keep HTTP and database-driver types out of services; adapters translate `pgtype` values. Nullable API fields encode as JSON `null`, not empty strings.

Repositories depend on small local query interfaces, not the entire generated `db.Querier`, so unrelated sqlc changes don't break their tests.

For endpoint declarations and codegen, see `route-workflow.md`. For migrations, see `database-workflow.md`.

## Authentication and requests

- Protect `/v1` routes with `requireAuthentication` unless deliberately public (such as auth entrypoints). For tenant resources, call `authorization.TenantPolicy.AuthorizeTenant` with the principal, requested tenant, and permission before reading or writing.
- Treat cross-tenant listings and queries without tenant filters as privileged. Test anonymous `401` and authenticated-but-unauthorized `403` cases.
- Bound bodies with `http.MaxBytesReader`. Keep server read/write/idle timeouts and header limits.
- Rate-limit credential and existence-probing endpoints; use generic failure responses. Keep expiry/revocation filters in credential queries as well as service checks.
- Require TLS and real secrets outside `local`. Profiling/debug routes need an explicit local-environment check, not just a feature flag.
- Validate or escape caller-controlled URL/path segments; trimming is not validation.
