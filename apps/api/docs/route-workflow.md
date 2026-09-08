# API routes

Follow the neighboring domain's endpoint, service, repository, and tests. For storage changes, use `database-workflow.md`; for Go conventions, use `code-standards.md`.

Define the method/path, input/output schemas, errors, auth, rate limits, and idempotency with the implementation. Wire new services in `cmd/main.go`.

## Endpoint declarations

Every normal `/v1` route is an `Endpoint[Request, Response]` factory in its
domain HTTP file. Health/readiness and deliberately unusual protocol surfaces
are the exceptions.

Each endpoint should make the route shape reviewable at the callsite:

- `Get`, `Post`, or `Patch` with public path, mount path, operation ID, decoder,
  and endpoint logic.
- `Auth(APIAuthSessionOrBearer)` for protected routes.
- `Middleware(...)` only when the route owns additional middleware outside the
  router group.
- `RateLimit(...)` for public auth routes and authenticated writes.
- `Parameters(...)` for every path/query parameter.
- `RequestBody(...)` for JSON bodies.
- `Responds(...)` for JSON responses, or `RespondsNoBody(...)` plus
  `ResponseHeaders(...)` for redirects and other bodyless successes.
- `Errors(...)` for every stable API error the route can intentionally return.
- `MapErrors(...)` to translate service/adapter/domain errors into API errors.
- `WriteWith(...)` only for response behavior that plain JSON cannot express,
  such as setting cookies or issuing redirects.

The endpoint logic should receive a typed request value, check service
readiness, perform authz after route IDs are parsed, call the service, and
return a typed response or error. Keep response writing out of the endpoint
logic unless it belongs in a `WriteWith` writer.

## Code generation

The endpoint contract is consumed by `PreviewRouteContracts()`.

- Add every domain's endpoint list to `PreviewRouteContracts()` in
  `internal/httpapi/contracts.go`.
- Reuse shared parameter helpers from `internal/httpapi/query.go`.
- Reuse shared error constants from `internal/httpapi/errors.go`; add new
  constants when a route exposes a stable new API error.
- Reuse shared optional/nullable transport helpers so schema output describes
  the wire shape, not Go internals.
- Update the retained route contract proof when the intentional route
  inventory changes.

## Verify

Run `apps/api/scripts/gate.sh` from the repository root. After route-contract changes, run root `pnpm run generate:sdk` and inspect the changed OpenAPI/SDK output. The root gate checks generated-file drift.

Use `../../../docs/observability.md` for journey propagation and success/failure checks. Verify public capabilities through their SDK entry point too. Webhooks need typed events, raw-body signature verification, idempotent processing, fixtures, and docs; keep server-only code out of browser bundles.
