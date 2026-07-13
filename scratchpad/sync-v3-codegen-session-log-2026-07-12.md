# Sync v3 codegen session log — 2026-07-12

- 2026-07-12 23:55 PKT — Read repository, sync-app, code, and writing instructions; inspected the frozen v3 schema, existing v1/v2 emitters, generated outputs, tests, and codegen scripts.
- 2026-07-13 00:02 PKT — Confirmed v3 declares the required frame categories and bounds, while projection and directed-request concrete wire keys are only described semantically; asked the integration owner for the approved shape and continued on unambiguous contract support.
- 2026-07-13 00:05 PKT — Consumed the centrally frozen live-target, directed-request, projection, operation, snapshot, and control-event wire declarations; generated strict TypeScript and Elixir v3 decoders plus deterministic golden outputs and fixtures.
- 2026-07-13 00:13 PKT — Focused codegen suite passed 24/24, including byte-identical v1/v2/v3 regeneration, all v3 operation and event payload variants, negative exact-key/bound/invariant cases, and isolated execution of the generated Elixir decoder.
- 2026-07-13 00:15 PKT — TypeScript compilation, isolated Elixir compilation, JavaScript and shell syntax checks, diff hygiene, and scoped v3 regeneration drift checks passed. The repository-wide drift script remains red because unrelated in-flight webhook API changes have not regenerated the checked-in OpenAPI artifacts; it failed before reaching sync comparisons.
