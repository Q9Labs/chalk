# Route Workflow

Use this when adding or changing API routes. The route definition is the source
of truth for both runtime behavior and generated contract previews, so keep the
transport shape explicit and close to the code that serves it.

## 0. Orient In The Codebase

Read enough nearby code to understand the existing slice:

- The HTTP file for the closest domain.
- The matching service and repository interfaces.
- The Postgres adapter and sqlc query files.
- The DB schema and migrations for the relevant tables.
- The router mount point and `cmd/main.go` wiring.
- Existing tests for the same route shape.

Prefer the local endpoint pattern over introducing a one-off route shape.

## 1. Define The Contract

Start from the user or system action and describe the contract before filling in
the implementation:

- Method and `/v1` path.
- Path params, query params, headers, and JSON body.
- Success status, response body, nullable fields, timestamps, and pagination.
- Stable error codes and HTTP statuses.
- Authn, tenant/global authz, rate limits, and idempotency where relevant.
- Data requirements: migrations, indexes, constraints, sqlc queries, and
  transactions.
- Observability requirements: logs, metrics/traces, audit records, and debug
  hooks.

If any part of the contract is intentionally deferred, name it plainly in the
handoff so it is not mistaken for an omission.

## 2. Implement The Slice

Follow `docs/code-standards.md` and keep the chain explicit:

```text
HTTP endpoint -> service interface -> service -> repository interface -> Postgres adapter -> sqlc query
```

Typical implementation order:

1. Add or update migrations and `db/schema.sql` when storage changes.
2. Add sqlc queries and regenerate code with `apps/api/scripts/db-generate.sh`.
3. Add service types, errors, validation, and repository interface methods.
4. Add Postgres repository mapping between domain types and sqlc/pgx types.
5. Add HTTP DTOs, decoders, endpoint factories, error mapping, and route mounts.
6. Wire the service and repository in `cmd/main.go`.
7. Add focused tests at the lowest useful layer, then HTTP tests for transport
   shape, auth, authz, rate limits, and error mapping.

Parse request-shaped values at the HTTP edge. Keep services free of HTTP types
and database-driver types.

## 3. Declare HTTP Endpoints

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

## 4. Keep Contracts Generator-Friendly

The endpoint contract is consumed by `PreviewRouteContracts()` and the
scratchpad OpenAPI proof generator.

- Add every domain's endpoint list to `PreviewRouteContracts()` in
  `internal/httpapi/contracts.go`.
- Reuse shared parameter helpers from `internal/httpapi/query.go`.
- Reuse shared error constants from `internal/httpapi/errors.go`; add new
  constants when a route exposes a stable new API error.
- Reuse shared optional/nullable transport helpers. If a new request wrapper
  type is needed, update the OpenAPI proof generator so schema output describes
  the wire shape, not Go internals.
- Update `internal/httpapi/route_contracts_test.go` when the intentional route
  inventory changes.
- Generate the proof contract with:

```bash
cd apps/api
go run ./scratchpad/sdk-generator-proof/contractopenapi
```

The generated preview should include the expected path, method, operation ID,
auth metadata, parameters, request schema, success responses, response headers,
and `x-chalk-error-codes`.

## 5. Verify The Change

For Go API work, use the focused API gate:

```bash
apps/api/scripts/gate.sh
```

For route-only changes, also inspect the generated contract preview for the
specific routes touched. If the full gate is blocked by unrelated dirty work,
run the equivalent checks for the touched slice and call out the blocker in the
handoff.

## 6. Handoff

Provide a short review map Hasan can quickly inspect:

- Routes or behaviors added or changed.
- Contract shape: inputs, outputs, parameters, auth, rate limits, and errors.
- Key files with clickable full paths and line numbers.
- Functions/types worth reading first.
- Concerns, tradeoffs, or open questions.
- Verification passed and anything skipped or blocked.

Do not redo the whole code review in prose. Point at the code paths that matter.
