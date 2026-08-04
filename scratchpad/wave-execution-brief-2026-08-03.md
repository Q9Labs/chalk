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

8. `scratchpad/wave-8-reconciliation-prompt-2026-08-04.md` — reconcile
   local `master`, the completed rename tip, the dashboard completion tail,
   and the dirty live Episode debugger work. After waves 6 and 7. This is an
   extraction and adaptation wave, not a wholesale merge of stale trees.

## Rulings: all closed (2026-08-03 night)

Every decision the prompts defer to Hasan is ruled and recorded in
`GLOSSARY.md`; the full sheet with reasoning is
`scratchpad/overnight-rulings-2026-08-03.md`. No wave waits on a human
overnight. The only follow-ups land in wave reports for the morning:

- Wave 4 lists every user-visible string it wrote (copy review).
- Waves 5/6 list deploy-time cutovers (renamed secrets, stacks, hosted
  dashboards/alerts) for Hasan to apply in step.
- npm publish of the 4.0.0 packages is manual, after wave 4 and Hasan's
  verification pass — nothing publishes overnight.
