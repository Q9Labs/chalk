# Wave execution brief — 2026-08-03

Index for executing the remaining rename-and-redraw waves. Each wave has
a self-contained prompt file — hand the file to the executing agent as
its instructions; nothing else from this session is required. The design
sheets the prompts cite are ratified and not open for redesign.

## State

- Wave zero merged to master (98968f04): legacy sync deleted, protocol
  renumbered v3→v1, full gate green. UI-primitives consolidation merged.
- Ratchet baseline locked; `GLOSSARY.md` is the only vocabulary SOT.
- Deliberately unrenamed: DB `sync_v3_*` identifiers — they die in wave
  1's migration squash.

## Wave prompts, in order

1. `scratchpad/wave-1-contract-prompt-2026-08-03.md` — contract, DB, Go
   API, server adoption. AccessGrant renames on the wire here FIRST.
2. `scratchpad/wave-2-client-sdk-prompt-2026-08-03.md` — SpaceClient
   split. After 1.
3. `scratchpad/wave-3-react-prompt-2026-08-03.md` — `<Chalk />`,
   Entrance, hooks, theme + CI token-reach check. After 2.
4. `scratchpad/wave-4-apps-prompt-2026-08-03.md` — web + mobile
   adoption. After 3.
5. `scratchpad/wave-5-infra-prompt-2026-08-03.md` — broker + infra.
   After 2; parallel with 6.
6. `scratchpad/wave-6-observability-prompt-2026-08-03.md` — telemetry
   vocabulary. After 3; parallel with 5.

Wave 7 (marketing/docs) is Claude's, running alongside: root README,
`docs/`, store listing, glossary, marketing copy. Per-package READMEs
belong to their code waves. Docs written from the ratified sheets are
acceptance canon — waves make the documented code real.

## Needs Hasan personally (each ruling lands in GLOSSARY.md first)

- Before wave 1's sync renames: true names for Elixir `Live.Session`
  (media/presence) and `Sessions.Coordinator` (socket delivery) — never
  ruled; only the Go "session" (→ Episode) was.
- Before wave 2 merges: the `@q9labsai/*` version/publish decision —
  every public surface breaks.
- Before wave 3: final React hook names + the RN ClientSession true name.
- Before wave 5: the broker "MeetingSession" true name (edge lease).
- During wave 4: turnkey copy (product voice).
- Waves 5/6 reports will list deploy-time cutovers (renamed secrets,
  stacks, hosted dashboards/alerts) for Hasan to apply in step.
