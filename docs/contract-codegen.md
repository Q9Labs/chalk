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

The root gate includes contract checks. For endpoint declarations, see [the API route guide](../apps/api/docs/route-workflow.md).

## Preserve semantics

- Keep branded IDs, reusable schema references, executable constraints, tagged errors, and discriminated protocol messages. Required and nullable are separate properties.
- Keep output deterministic. Reject duplicate declaration/operation/message IDs, missing references, impossible constraints, ambiguous unions, and untyped payloads; don't silently widen known fields to `unknown`.
- Preserve HTTP parameters, authentication, headers, body/rate limits, and operation-scoped errors. A wire error code may repeat across unambiguous operations/statuses.
- Preserve sync-v1 recovery, typed commands/events, acknowledgements, terminal results, cursor/revision chains, and connection behavior.
- Public routes and accepted/emitted frames must match their generated contracts. Don't remove the Go exporter until runtime-route and semantic parity are established, including manually mounted integrations.
- Breaking changes need an explicit version decision and compatibility report. Test changed generated bindings against their runtime and SDK consumers, not just a successful generator exit.

The default TypeScript client is Promise-based; Effect is an optional subpath. Keep framework/Effect dependencies out of the default consumer graph. Do not add empty language-SDK shells before a working client exists.

## Frontend fixture proof

`tools/contract-fixture-proof` compares TypeSpec and Chalk-native JSON on a representative fixture through `ContractIR`. The [generated report](../contract/generated/frontend-proof.report.md) records coverage, diagnostics, dependency cost, deterministic output, and the unresolved frontend decision.

Fixture parity is not universal contract equivalence. Production emitters remain independent of that selection. Keep source-language/compiler objects out of the shared IR; do not turn the proof's old migration plan or scoring rubric into instructions for routine SDK changes.
