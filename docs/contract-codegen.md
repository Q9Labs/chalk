# Chalk Contract And SDK Codegen

## Purpose

Chalk has one language-neutral client/server contract. That contract describes
the HTTP control plane and the real-time sync protocol, then generates the wire
types, validation schemas, clients, and server bindings used by every supported
language.

Generated output must preserve Chalk semantics rather than flattening the API
into generic strings and unknown objects. IDs remain branded references,
validation constraints remain executable, entities remain reusable, errors
remain tagged unions, and protocol messages remain discriminated by their wire
tags.

The contract system is internal build infrastructure. SDK consumers install
finished language packages and never run Chalk's generator.

## Repository Ownership

The existing application roots remain stable:

- `apps/api` owns the Go control-plane runtime.
- `apps/sync` owns the Elixir sync-engine runtime.
- `apps/web` and `apps/mobile` own first-party product surfaces.

The contract and SDK roots have separate responsibilities:

- `contract` owns authored language-neutral schemas and generated public
  protocol documents.
- `tools/contract-codegen` owns the private compiler, normalized IR, emitters,
  compatibility checks, fixtures, and golden tests.
- `sdks` owns distributable language SDKs.
- `packages` owns reusable cross-surface libraries such as assets, UI,
  whiteboard, and Facehash.
- `scripts` owns thin repository orchestration and quality gates. Generator
  implementation does not live there.

The target layout is:

```text
contract/
  schema/
  generated/
    openapi.json
    asyncapi.json
    json-schema/

tools/contract-codegen/
  src/frontends/
  src/ir/
  src/emitters/
  test/fixtures/
  test/golden/

sdks/
  typescript/
    client/
    react/
    react-native/
  swift/
  kotlin/
  python/
  go/

packages/
  assets/
  ui/
  whiteboard/
  facehash/

apps/
  api/
  sync/
  web/
  mobile/
```

## Contract Pipeline

All frontends normalize into a Chalk-owned `ContractIR`. Every output is
generated from that IR:

```text
authored contract
      -> frontend adapter
      -> ContractIR
      -> OpenAPI and sync protocol documents
      -> language SDK wire types and clients
      -> Go and Elixir server bindings
```

Emitter behavior never depends directly on TypeSpec compiler objects, Go
reflection values, or an OpenAPI parser. This keeps source-language selection
replaceable and makes every target consume the same semantics.

The checked-in IR format is versioned. A frontend must reject unsupported IR
versions and emit deterministic output. Object keys, declarations, operations,
messages, and errors use stable sorting so regeneration is byte-reproducible.

## Frontend Selection

The initial implementation compares two frontends over the same representative
contract:

1. TypeSpec, used as a parser, type checker, and semantic-model provider.
2. A minimal Chalk-native declarative JSON format parsed with a
   location-preserving parser that rejects duplicate keys, then validated by
   `tools/contract-codegen`.

The proof contract includes:

- Reusable `Tenant`, `User`, and `Room` entities.
- Branded `TenantId`, `UserId`, `RoomId`, and `ParticipantId` scalars.
- String length, numeric range, format, enum, optional, nullable, array, record,
  and recursive-reference constraints.
- Three representative HTTP operations covering path/query parameters,
  authentication, request bodies, body limits, rate limits, success headers,
  response variants, and stable errors.
- Sync protocol version 1 frames for `hello`, snapshot/replay `welcome`, typed
  commands, typed events, acknowledgement outcomes, protocol errors, `ping`,
  and `pong`.
- Durable stream cursor and revision-chain semantics.

Both frontends must produce byte-identical canonical IR for the representative
fixture. That result proves fixture parity, not semantic equivalence for every
contract. A selection additionally requires cross-field semantic validation,
clean source-located semantic diagnostics, exact dependency pins, and
byte-identical output across 20 runs. The decision rubric is:

- semantic coverage, weighted 35%;
- quality and source precision of invalid-contract diagnostics, weighted 20%;
- maintained frontend and adapter implementation size, weighted 15%;
- editor and contributor ergonomics, weighted 15%;
- installation footprint, weighted 10%;
- ease of replacing the frontend without changing emitters, weighted 5%.

TypeSpec is selected when its adapter remains narrow and its compiler removes
substantial parser, reference-resolution, and diagnostics work. The Chalk JSON
frontend is selected when TypeSpec requires enough custom decorators and
protocol interpretation to approach the complexity of the native frontend.

The losing proof frontend is removed after the decision. Tests retain a
frontend-neutral IR fixture so emitters remain decoupled.

The current comparison is inconclusive after critical review. The generated
HTTP and sync emitters remain independent of this frontend decision. The
checked-in report at
`contract/generated/frontend-proof.report.md` records fixture coverage,
diagnostics, measured implementation and dependency cost, its known proof
limits, and the canonical hash. The chosen frontend enters the production
pipeline only after the missing validation and diagnostic gates pass; the
losing frontend then leaves the production dependency graph while the report
and frontend-neutral IR fixture remain.

## Contract IR

`ContractIR` contains protocol semantics, not target-language syntax. Its top
level includes:

- IR version and Chalk contract version;
- named scalar, enum, object, union, array, and record schemas;
- reusable brands, formats, constraints, examples, and documentation;
- object fields whose `required` and `nullable` properties are independent;
- HTTP services, operation groups, operations, parameters, bodies, responses,
  headers and serialization, authentication alternatives, rate limits, body
  limits and content types, and operation-scoped errors;
- sync services, channels, frame direction, protocol version, message unions,
  commands, events, snapshots, acknowledgements, errors, close codes, streams,
  cursor rules, revision rules, connection phases and transitions, correlation
  and idempotency behavior, snapshot fallback, and whether an error closes or
  preserves the connection.

Named schemas are references by default. Emitters may inline anonymous
operation wrappers, but reusable IDs, entities, errors, frames, commands,
events, and payloads remain named references.

Unknown values are intentional only where the contract explicitly declares
them, including opaque metadata and provider-owned after-details. Provider
configuration uses known discriminated schemas.

## Custom Emitters

Chalk owns its emitters. Generic generators may be used only as comparison
fixtures and are never the source of a published SDK surface.

The initial emitters produce:

- OpenAPI 3.1;
- JSON Schema for sync frames and shared models;
- AsyncAPI when it adds interoperable channel documentation without weakening
  the richer Chalk IR;
- TypeScript wire types;
- Effect v4 schemas with constraints, brands, references, transforms, and
  tagged error classes;
- Effect v4 `HttpApi` endpoint groups and a configured client factory;
- TypeScript sync frame unions and protocol codecs;
- Go server contract types or conformance bindings;
- Elixir sync protocol validators, typespecs, fixtures, or codecs.

The Effect output remains a custom target because it is part of the product
API. It includes first-class error unions, generated error tags, response
header schemas, authentication/header injection, and explicit support for
rate-limit, retry, download, and body-limit metadata.

## Generated Output

Generated source is checked in and marked as machine-owned. SDK releases bundle
generated source into the corresponding language package. Applications and
services do not run generation at startup or installation time.

TypeScript output lives under:

```text
sdks/typescript/client/src/generated/
```

The framework-free TypeScript client owns generated HTTP and sync vocabulary.
Its default public API is Promise-based. Effect users import the optional
`effect` subpath, which requires a compatible Effect peer without adding Effect
to the default installation graph.

Generated server artifacts live with their consumers:

```text
apps/api/internal/contract/generated/
apps/sync/lib/chalk_sync/contract/generated/
```

OpenAPI, JSON Schema, and AsyncAPI are published protocol documents under
`contract/generated`. OpenAPI remains available to customers and external
tooling even when it is no longer the authored source.

## Shared Packages And Assets

Shared assets are not SDK-specific. `packages/assets` owns framework-neutral
asset metadata, semantic IDs, CDN URLs, hashes, MIME types, dimensions,
durations, and fallback information. Large images, sounds, and backgrounds stay
on `assets.chalkmeet.com` and are not bundled into packages.

`packages/ui`, `packages/whiteboard`, and `packages/facehash` remain reusable
libraries consumed by SDKs and first-party apps. SDK packages depend on these
libraries through intentional public or bundled boundaries; applications do
not reach into SDK source paths.

## Migration Map

- `packages/sdk-core` becomes `sdks/typescript/client` and gains a complete
  package manifest, build, tests, and workspace coverage.
- `packages/sdk-react` becomes `sdks/typescript/react`.
- `packages/sdk-react-native` becomes `sdks/typescript/react-native`.
- `packages/chalk-whiteboard` becomes `packages/whiteboard`.
- Framework-neutral asset metadata moves from `packages/ui` to
  `packages/assets`.
- `scripts/codegen` implementation moves to `tools/contract-codegen`.
- `apps/api/openapi/openapi.json` becomes `contract/generated/openapi.json`.
- `apps/api/cmd/codegen` remains a transitional exporter until generated Go
  route descriptors participate in mounting, or a conformance test proves the
  live Chi route inventory and operation metadata equal the contract. It is
  removed only after complete route and semantic parity.
- `apps/sync/lib/chalk_sync/protocol.ex` consumes generated contract bindings
  while room state-machine behavior remains hand-written.

Moves preserve history and avoid unrelated refactors. Generated moves and
semantic regeneration remain reviewable as separate changes within the final
implementation history.

## Commands And Gates

The root commands are:

```text
pnpm contract:generate
pnpm contract:check
```

`contract:generate` writes every checked-in artifact. `contract:check`
regenerates into a unique temporary directory and byte-diffs every expected
output without mutating the worktree.

The canonical root gate runs `contract:check`. The API and sync gates compile
and test against generated bindings. Package publishing checks include SDKs and
shared packages instead of assuming every publishable package is under
`packages/*`.

## Compatibility And Failure Rules

- Every mounted public `/v1` HTTP route has exactly one contract operation.
- Every accepted or emitted sync frame belongs to the generated protocol union.
- Duplicate operation IDs, message tags, schema declaration IDs, brands, and
  error declaration IDs fail generation. Wire error codes such as `not_found`
  may repeat when their operation and status scopes are unambiguous.
- Missing references, impossible constraints, unsupported recursion, ambiguous
  unions, and untyped command/event payloads fail with source-oriented
  diagnostics.
- Generated output never silently widens a known field to `unknown`.
- Contract-breaking changes require an explicit contract-version decision and
  generated compatibility report.
- Integration routes currently mounted outside endpoint contracts must enter
  the source contract before the Go reflection generator is removed.

## Verification

The implementation is complete when all of the following are observed:

- Both proof frontends run over the representative contract and produce a
  written comparison; the selected frontend is the only production frontend.
- Repeated generation produces byte-identical output.
- OpenAPI describes the complete mounted `/v1` route inventory.
- A Go conformance test compares the live Chi route inventory and generated
  operation descriptors, including integration routes that are currently
  mounted manually.
- TypeScript and Effect generated code passes strict type checking.
- Effect schemas decode representative successes, headers, and every tagged
  error family.
- A generated HTTP client performs an authenticated request against a local API
  route and decodes its response.
- A generated sync client completes hello/welcome, command/ack, and event flow
  against the local Elixir sync engine.
- Go and Elixir service tests prove generated bindings match runtime wire
  behavior.
- Empty-project package installation proves the default client does not install
  React, React Native, Excalidraw, or Effect.
- Focused API and sync gates pass.
- The full `pnpm run gate` passes.
- Auto code review reports no unresolved findings.

## Non-Goals

- Generating handwritten meeting behavior, room-state decisions, or UI logic.
- Publishing the generator for customer-defined APIs.
- Replacing the JSON wire protocols with Protobuf or another transport.
- Moving the API or sync engine out of `apps`.
- Moving shared libraries out of `packages`.
- Adding incomplete Swift, Kotlin, Python, or Go SDK shells before their first
  generated client can be verified end to end.
