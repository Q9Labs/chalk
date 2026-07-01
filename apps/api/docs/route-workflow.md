# Route Workflow

Use this when adding or changing API routes. The goal is to move fast without
turning every endpoint into a one-off.

## 0. Orient In The Codebase

Before designing or editing, read enough nearby code to understand the local
pattern:

- The existing HTTP file for the closest domain.
- The matching service and repository interfaces.
- The Postgres adapter and sqlc query files.
- The DB schema and existing migrations for the relevant tables.
- The router mount point and `cmd/main.go` wiring.
- Existing tests for the same route shape.

Prefer existing proven patterns over inventing a new one.

## 1. Decide The Intent

Start with the user or system action, not the handler name:

- The route method and path under `/v1`.
- The resource or use case.
- The caller and why they need it.
- Whether the route belongs in an existing domain mount or a new domain file.

## 2. Finalize The Contract

Before implementation, agree on the parts clients and operators will feel:

- Request: path params, query params, headers, and body.
- Response: body shape, timestamps, nullable fields as JSON `null`, and
  pagination metadata for list endpoints.
- Errors: stable error codes and HTTP statuses.
- Access: authn/authz, rate limits, and idempotency where relevant.
- Data: migrations, indexes, constraints, sqlc queries, and transactions.
- Observability: logs, metrics/traces, audit needs, and noisy debug hooks.

If any of these are intentionally deferred, name the deferment plainly so it is
not mistaken for an omission.

## 3. Implement The Slice

Follow `docs/code-standards.md` and keep the chain explicit:

```text
HTTP route -> service interface -> service -> repository interface -> Postgres adapter -> sqlc query
```

Typical implementation order:

1. Add or update migrations and `db/schema.sql` when storage changes.
2. Add sqlc queries and regenerate code with `apps/api/scripts/db-generate.sh`.
3. Add service types, errors, validation, and repository interface.
4. Add Postgres repository mapping between domain types and sqlc/pgx types.
5. Add HTTP request/response DTOs, route parsing, error mapping, and mounting.
6. Wire the service and repository in `cmd/main.go`.
7. Add focused tests at the lowest useful layer, then HTTP tests for transport
   shape and error mapping.

Parse request-shaped values at the HTTP edge. Keep services free of HTTP types
and database-driver types.

## 4. Run The Loop

For Go API work, use the focused API gate:

```bash
apps/api/scripts/gate.sh
```

If the gate is blocked by unrelated dirty work, run the equivalent checks that
apply to the touched slice and call out the blocker in the handoff.

## 5. Guided Code Review

After implementation, provide a short review map Hasan can quickly inspect in
Zed. Keep it concrete and easy to open:

- What changed.
- Routes or behaviors added.
- Key files with clickable full paths and line numbers.
- Functions/types worth reading first.
- Concerns, tradeoffs, or open questions.
- What verification passed and what was skipped or blocked.

Do not redo the whole code review in prose. Point at the code paths that matter.
