# API routes

Follow the neighboring domain's endpoint, service, repository, and tests. Use the [database workflow](database-workflow.md) for storage changes and [Go conventions](code-standards.md) for Go code.

Normal `/v1` routes use a typed `Endpoint[Request, Response]` in the domain's HTTP file; health and unusual protocol routes are exceptions. Declare the wire contract, errors, authentication, and idempotency behavior alongside the endpoint. Rate-limit public authentication routes and authenticated writes. Authorize after parsing route IDs, and wire new services in `cmd/main.go`.

Endpoint declarations feed `PreviewRouteContracts()` in `internal/httpapi/contracts.go`; add new domain endpoint lists there. Reuse the shared parameter, error, and transport helpers so the generated schema describes the wire format. Update the retained route-contract proof when the intentional route inventory changes.

For contract changes, run `pnpm run generate:sdk` from the repository root and inspect the generated OpenAPI and SDK changes. The API gate (`apps/api/scripts/gate.sh`) checks generated drift. Verify public capabilities through their SDK entry point too.

Use [observability guidance](../../../docs/observability.md) for journey propagation and success/failure checks. Webhooks need typed events, raw-body signature verification, idempotent processing, fixtures, and docs; keep server-only code out of browser bundles.
