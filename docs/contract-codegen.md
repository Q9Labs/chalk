# Contract generation

Chalk publishes generated artifacts with its SDKs. Consumers don't run the generator.

## Pipeline

- `apps/api/scripts/generate-openapi.sh` exports the Go API endpoint contracts to `contract/generated/openapi.json`.
- `scripts/codegen/generate-sdk.sh` runs the HTTP, sync-v1, and whiteboard emitters under `tools/contract-fixture-proof/src/emitters/` and formats their output.
- TypeScript output lives in `sdks/typescript/client/src/generated/`; Elixir bindings live in `apps/sync/lib/chalk_sync/contract/`.
- Generated output is checked in. Runtime services and package installation don't regenerate it.

From the repo root:

```sh
pnpm run generate:sdk      # API/SDK protocol output
pnpm run contract:generate # also fixture proof and API design artifacts
pnpm run contract:check    # non-mutating drift and contract checks
```

`pnpm run regen` runs every generator in dependency order: SDK, OpenAPI, Sync contract, sqlc, migration `LatestVersion`, and tracker views. `pnpm run check:generated` verifies all of them in seconds without Postgres or Docker. Run `pnpm run hooks:install` once so rebases keep one side of generated files without conflicts; then run `pnpm run regen` to rebuild them. Toolchain versions live in `.tool-versions` (Node, Erlang, Elixir, OpenTofu), `apps/api/go.mod` (Go), and `packageManager` (pnpm). The language ratchet baseline is a reviewed baseline, not generated output: `check:generated` runs it but `regen` never rewrites it.

The root gate includes contract checks. For endpoint declarations, see [the API route guide](../apps/api/docs/route-workflow.md).

## Preserve semantics

- Keep branded IDs, reusable schema references, executable constraints, tagged errors, and discriminated protocol messages. Required and nullable are separate properties.
- Keep output deterministic. Reject duplicate declaration/operation/message IDs, missing references, impossible constraints, ambiguous unions, and untyped payloads; don't silently widen known fields to `unknown`.
- Preserve HTTP parameters, authentication, headers, body/rate limits, and operation-scoped errors. A wire error code may repeat across unambiguous operations/statuses.
- Preserve sync-v1 recovery, typed commands/events, acknowledgements, terminal results, cursor/revision chains, and connection behavior.
- Public routes and accepted/emitted frames must match their generated contracts. `PreviewRouteContracts` is the Go export inventory; endpoint collections should feed both it and runtime mount helpers. Don't remove the Go exporter until runtime-route and semantic parity are established.
- Breaking changes need an explicit version decision and compatibility report. Test changed generated bindings against their runtime and SDK consumers, not just a successful generator exit.

The default TypeScript client is Promise-based; Effect is an optional subpath. Keep framework/Effect dependencies out of the default consumer graph. Do not add empty language-SDK shells before a working client exists.
