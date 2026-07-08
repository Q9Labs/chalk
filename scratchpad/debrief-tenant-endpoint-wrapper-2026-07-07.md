# Tenant Endpoint Wrapper Debrief - 2026-07-07

## Grand Summary

This experiment converts the tenant HTTP slice to typed endpoint values, so the same object now mounts the route and exposes the contract used by the generator. Verdict: solid as a proof of direction, but not yet a pattern I would roll across the API without tightening drift checks around auth, paths, and error sets. The nice outcome is that generation no longer needs a separate handwritten create-tenant contract; the uncomfortable outcome is that some API facts are still necessarily explicit.

## Walkthrough

- `apps/api/internal/httpapi/endpoint.go:12` introduces `RouteEndpoint`, the interface the router and generator both consume.
- `apps/api/internal/httpapi/endpoint.go:21` defines `Endpoint[Request, Response]`: contract metadata plus a decoder, a typed handler, and an optional error mapper.
- `apps/api/internal/httpapi/endpoint.go:28` adds method-specific builders `Get`, `Post`, and `Patch`; route authors see the HTTP method up front while all three share `newEndpoint`.
- `apps/api/internal/httpapi/endpoint.go:53` is the fluent contract surface: auth, rate limit, request body, response, parameters, error codes, and error mapping.
- `apps/api/internal/httpapi/endpoint.go:93` mounts the endpoint into Chi and applies the endpoint's rate-limit policy during mount.
- `apps/api/internal/httpapi/endpoint.go:105` is the central request lifecycle: decode request, call typed handler, map errors, encode JSON response.
- `apps/api/internal/httpapi/contracts.go:21` adds parameter metadata so generated OpenAPI can describe `tenant_id`, `page_size`, and `cursor`.
- `apps/api/internal/httpapi/contracts.go:41` now gets preview contracts from `tenantEndpoints(nil, nil)`, so generation reads the same endpoint registry as routing.
- `apps/api/internal/httpapi/errors.go:5` makes `APIError` an error value, letting endpoint handlers return defined API errors instead of writing raw strings.
- `apps/api/internal/httpapi/authorization.go:28` adds pure authorization helpers returning errors; old writer-style helpers remain for memberships/users.
- `apps/api/internal/httpapi/pagination.go:75` adds `paginationAPIError`, which lets endpoint decoders return defined pagination errors.
- `apps/api/internal/httpapi/tenants.go:91` mounts tenant routes by iterating endpoint values.
- `apps/api/internal/httpapi/tenants.go:107` rewrites create tenant as `Post[createTenantRequest, tenantResponse]` with body schema, `201` response, auth, rate limit, errors, and tenant service error mapping.
- `apps/api/internal/httpapi/tenants.go:137` rewrites tenant listing as a typed endpoint with query parameter metadata and global-read authorization in the handler.
- `apps/api/internal/httpapi/tenants.go:176` rewrites tenant get with path parameter decoding plus tenant authorization.
- `apps/api/internal/httpapi/tenants.go:207` rewrites tenant update with path+body decoding, body schema, rate limit, and optional update fields.
- `apps/api/internal/httpapi/tenants.go:245` rewrites regions listing as a typed endpoint and replaces the anonymous map response with a named response DTO.
- `apps/api/internal/httpapi/tenants.go:278` keeps request parsing close to HTTP while making parse failures return typed API errors.
- `apps/api/internal/httpapi/tenants.go:316` centralizes tenant endpoint error mapping across API errors, tenant service errors, and authorization errors.
- `apps/api/scratchpad/sdk-generator-proof/contractopenapi/main.go:75` reads the endpoint-derived route contracts and emits OpenAPI operations.
- `apps/api/scratchpad/sdk-generator-proof/contractopenapi/main.go:149` emits OpenAPI path/query parameters from endpoint metadata.
- `apps/api/scratchpad/sdk-generator-proof/contractopenapi/main.go:193` special-cases `utilities.OptionalString`, so `PATCH /v1/tenants/{tenant_id}` generates optional `string | null` fields instead of the internal `{Set, Value}` transport helper.
- `apps/api/scratchpad/sdk-generator-proof/contractopenapi/generated/openapi.json:1` is the regenerated preview covering the tenant and regions endpoints.

## Findings

- Minor maintainability: `apps/api/internal/httpapi/endpoint.go:40` still asks for both public `path` and Chi `mountPath`. This can drift because `/v1/tenants` and `/tenants` are manually paired. Suggested fix: make endpoint mounting aware of the route group prefix or register endpoints at the `/v1` router boundary so one path value can serve both mounting and OpenAPI.
- Minor correctness/maintainability: `apps/api/internal/httpapi/tenants.go:120` declares auth metadata, but runtime auth is still enforced by the surrounding router group in `router.go`, not by `Endpoint.Auth`. Moving an endpoint out of the group would make docs and runtime disagree. Suggested fix: either let endpoint auth apply middleware itself or add a registry test that asserts every endpoint with auth metadata is mounted under `requireAuthentication`.
- Minor maintainability: `apps/api/internal/httpapi/tenants.go:124` manually lists error codes while `tenantEndpointAPIError` maps actual runtime errors at `apps/api/internal/httpapi/tenants.go:316`. This is still explicit contract work and can drift. Suggested fix: add generated OpenAPI golden tests per endpoint and consider named reusable error sets, e.g. `tenantWriteErrors`.
- Minor extensibility: `apps/api/internal/httpapi/endpoint.go:105` assumes JSON request/response endpoints. That is fine for tenants, but it will not cover streaming, downloads, redirects, no-content responses, or custom headers without extending the wrapper. Suggested fix: keep this wrapper scoped to JSON REST endpoints and add separate endpoint kinds only when a real route needs them.
- Minor process: `apps/api/scripts/perf-local.sh` could not run because local Goose state is inconsistent: missing migration `20260706142000_add_tenant_provider_configs.sql` before current version `20260706151000`. Suggested fix: repair or wipe the local dev Postgres volume, then rerun the perf script before treating this as production-ready.

## Verification

- Passed: `go test ./internal/httpapi ./internal/traceharness ./cmd/trace ./scratchpad/sdk-generator-proof/contractopenapi`.
- Passed: `go run ./cmd/trace -scenario route:tenant-create -color never`.
- Passed: `apps/api/scripts/gate.sh`.
- Blocked: `apps/api/scripts/perf-local.sh`, by the local migration state above.

## Trace

Run the tenant trace from `apps/api`:

```bash
go run ./cmd/trace -scenario route:tenant-create -color always
```

That trace still goes through the real router and now exercises the endpoint wrapper before reaching the tenant service and repository doubles.
