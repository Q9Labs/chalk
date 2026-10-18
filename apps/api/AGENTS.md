# Chalk API

Go control-plane API. Keep `cmd/main.go` thin; put router, response helpers,
middleware, and domain packages under `internal/*`. Keep composable boundaries
and swappable `MediaPlane` and `SyncEngine` ports. Put provider details in
adapters. Keep public REST routes under `/v1`; leave operational routes such as
`/healthz` unversioned. Existing domains include identity, tenancy, Spaces,
Episode lifecycle, recordings, transcripts, and webhooks.

## Development

- Consult the relevant sections of `apps/api/docs/code-standards.md` when writing Go here.
- Read `apps/api/docs/route-workflow.md` before adding a new route.
- Read `apps/api/docs/database-workflow.md` when doing database work, including its two-release removal rule and required `chalk:removed-in` marker.
- Run the gate before committing: `scripts/gate.sh`.

## Media plane providers

- `internal/mediaplaneproviders` owns adapter-independent resolution contracts,
  errors, and telemetry types.
- `internal/adapters/mediaplaneproviders` owns configuration selection and
  concrete provider construction. Runtime composition may depend on that
  adapter package; HTTP, public-invite, and observability code depend only on
  inward contracts.

## API and SDK

- Public `/v1` API routes should use the endpoint contract pattern so
  `cmd/codegen` can include them in `../../contract/generated/openapi.json` and downstream SDK
  generation.
- After changing route contracts, run `pnpm run generate:sdk` from the repo root
  and keep `contract/generated/openapi.json` plus `sdks/typescript/client/src/generated/*`
  in sync. This includes OpenAPI types, Effect schemas, and the generated
  Effect `HttpApi` definition. The root gate runs
  `pnpm run check:sdk-generated` as a non-mutating drift check.
- Keep runtime mounting and `PreviewRouteContracts` sourced from the same endpoint
  collections. Use the generated OpenAPI/SDK artifacts and their drift check for
  current contract coverage instead of recording route-specific gap lists here.

## Observability

- Read `../../docs/observability.md` before adding or changing API behavior.
- Propagate the incoming journey ID and W3C trace context through service,
  repository, async, sync, and provider boundaries. Create a root only when the
  API is the first observer, and use span links for late callbacks or independent
  fan-out.
- Instrument meaningful success, rejection, retry, timeout, and terminal failure
  paths with bounded-cardinality metrics, structured logs, and spans. Keep
  credentials, tokens, webhook secrets, and sensitive payloads out of every
  signal.
- Extend the durable journey ledger when the behavior changes a user-visible
  lifecycle, and add or update the local observability end-to-end proof. A trace
  harness scenario helps explain the code path but does not replace operational
  telemetry or the observability proof.
