# Contract generation

Chalk publishes generated artifacts with its SDKs, and the generated output is checked in. Consumers, runtime services and package installation never run the generator. Change the source (Go endpoint declarations, sync-v1 and whiteboard contracts), then regenerate.

Run `pnpm run regen` after changing a contract, route, migration or other generator input. It runs every generator in dependency order; see `package.json` for the list. `pnpm run check:generated` finds stale output without Postgres or Docker. `pnpm run contract:check` runs the non-mutating contract checks, and the root gate includes it. Run `pnpm run hooks:install` once so rebases keep one side of generated files without conflicts, then run `pnpm run regen`. For endpoint declarations, see the [API route guide](../apps/api/docs/route-workflow.md).

`scripts/codegen/generate-sdk.sh` is the entry point for the SDK output: it exports the OpenAPI contract from the Go API and runs the emitters in `tools/contract-fixture-proof/src/emitters/` for TypeScript and Elixir.

## What generation must preserve

- Branded IDs, reusable schema references, executable constraints, tagged errors and discriminated protocol messages. Required and nullable are separate properties.
- Deterministic output. Reject duplicate declaration, operation and message IDs, missing references, impossible constraints, ambiguous unions and untyped payloads. Never widen a known field to `unknown`.
- HTTP parameters, authentication, headers, body and rate limits, and operation-scoped errors. A wire error code may repeat across unambiguous operations and statuses.
- Sync-v1 recovery, typed commands and events, acknowledgements, terminal results, cursor and revision chains, and connection behavior.
- Parity between public routes, accepted and emitted frames, and their generated contracts.
- A breaking change needs an explicit version decision and a compatibility report. Test changed bindings against their runtime and SDK consumers; a clean generator exit proves little.

Non-JSON attachment download operations stay in OpenAPI and the generated wire types but not in the generated JSON HTTP client. Consumers stream those responses over HTTP to keep the attachment headers.

The default TypeScript client is Promise-based, and Effect is an optional subpath; see [effect-ts.md](effect-ts.md). Don't add empty language-SDK shells before a working client exists.
