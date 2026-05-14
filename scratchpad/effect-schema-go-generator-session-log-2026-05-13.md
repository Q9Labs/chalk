# Effect Schema to Go Generator Session Log - 2026-05-13

Timestamp: 2026-05-13 18:55 PKT

Question explored: Can Chalk use TypeScript Effect Schema definitions as a source of truth to generate Go websocket/API contract types?

Summary:

- Built and tested a throwaway, gitignored logic prototype under `packages/sdk-core/prototypes/effect-go-generator`, then deleted it after the exploration.
- The prototype loaded representative Chalk Effect schemas, walked the Effect Schema AST, and rendered Go payload previews through a small terminal UI.
- The approach is viable as a bridge between the TypeScript Effect API/contracts and the Go websocket server, provided it is implemented as a policy-driven contract generator rather than a magical universal TypeScript-to-Go converter.

What worked:

- `Schema.Struct` maps cleanly to Go structs.
- Primitive schemas map cleanly to Go primitives.
- Literal unions can become Go enum-like string/int types.
- Arrays, records, optional fields, nullable fields, and raw JSON-shaped fields are all mechanically solvable.
- `Schema.DateFromSelf` and string/date unions can be handled with an explicit date policy such as `time.Time`, `string`, or `json.RawMessage`.
- Semantic fields such as `participantId`, `roomId`, `tenantId`, and `recordingId` can map to `uuid.UUID` through explicit overrides.

Important policy needs:

- Casing must be configurable per contract or schema group. Existing Go websocket payloads mostly use snake_case JSON tags, while some TypeScript outbound payloads intentionally use camelCase.
- UUID, `time.Time`, `int64`, and `json.RawMessage` cannot be inferred safely from Effect Schema alone; the generator needs overrides or annotations.
- Opaque `Schema.declare(...)` shapes, such as wide app state objects or browser-native values, should require an override or fall back to `json.RawMessage`.
- Discriminated unions need a deliberate Go strategy: either generated variant structs plus custom unmarshal logic, or an intentional `json.RawMessage` fallback where manual handling is clearer.

Prototype findings:

- The first useful generated preview for `WhiteboardDataPayload` produced the expected Go shape after applying UUID, casing, date, sequence, and raw JSON policies.
- Optional primitive unions and arrays of inline structs were initially too conservative and fell back to `json.RawMessage`; these are straightforward generator improvements.
- Complex unions surfaced clearly as warnings, which is useful behavior for a real generator.
- A compile gate should be part of any real implementation: emit to a temp package, run `gofmt`, then run targeted Go tests.

Recommended real implementation path:

1. Add a generator script near `packages/sdk-core/scripts`, using `tsx` or compiled TypeScript.
2. Load selected schema exports and schema maps from `packages/sdk-core/src/effect/schemas/*`.
3. Walk `schema.ast` directly for the supported subset.
4. Apply a checked config file for casing, semantic type overrides, raw JSON fields, date policy, and union policy.
5. Generate Go structs/enums into a clearly marked generated file in `apps/api/internal/interfaces/websocket` or a shared contract package.
6. Add golden fixtures and a compile verification step before trusting generated output.

Decision:

- Solvable and viable for Chalk.
- Do not pursue a dependency-heavy generic converter first.
- Build a narrow Chalk contract generator with explicit policy, warnings for unsupported constructs, and generated-output compile verification.
