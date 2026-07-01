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

## File Shape

- Put package-level errors, vars, constants, interfaces, and types near the top
  of the file.
- Put logic/functions after the definitions they operate on.
- Avoid alternating `types -> functions -> more types -> more functions` unless
  the file is generated or there is a strong local reason.

## Boundaries

- Keep `cmd/main.go` as the composition root. It should wire config, adapters,
  services, router, and lifecycle, not own domain behavior.
- HTTP handlers translate transport concerns into service inputs. Business
  decisions belong in services; database-driver details belong in adapters.
- Parse and validate request-shaped data as close to the HTTP edge as practical.
  Fail early before doing service or database work.
- Keep domain/service packages free of database-driver types such as `pgtype`.
  Translate those types in Postgres adapters only.
- Prefer reusable shared types for cross-cutting concepts such as IDs and
  optional JSON fields instead of redefining them per domain.
- API nullable fields should encode as JSON `null`, not empty strings.

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
