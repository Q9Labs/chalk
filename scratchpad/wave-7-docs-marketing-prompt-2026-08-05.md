# Wave 7 prompt — docs and marketing

You are executing Wave 7 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.

## Mission

Make every current public explanation of Chalk describe the canonical product:
a Space where Users and Agents participate, with each bounded run represented by
an Episode. Documentation must match the shipped Wave 1–6 API and UI exactly.

## Read first

- `GLOSSARY.md` — binding vocabulary and banned-term table.
- `scratchpad/wave-execution-brief-2026-08-03.md` — wave topology.
- `~/.codex/writing-style.md` — all prose must follow Hasan's writing style.

## Ownership

- Root `README.md`.
- `docs/**` and `apps/docs/**`.
- Current marketing and store-listing copy under `apps/web/**` and
  `apps/mobile/**`, but only prose/metadata assets; do not change application
  behavior or package-owned code.
- `GLOSSARY.md` only when its description of current implementation is stale;
  do not reopen ratified vocabulary decisions.
- A Wave 7 session log under `scratchpad/`.

Per-package READMEs belong to their code waves. Historical scratchpad material,
release history, migrations, vendored standards, and protocol fixtures are not
rewrite targets unless the current docs link to a stale path that no longer
exists.

## Execution rules

- Luna workers implement every rename and prose change.
- GPT-5.6 Terra at xhigh reasoning reviews only after implementation stabilizes.
- The rename is breaking and complete: do not document compatibility aliases,
  alternate legacy names, or planned future cleanup.
- Describe real shipped behavior. If code and docs disagree, report the seam;
  do not invent an API to make the prose read cleanly.
- Keep links, examples, command lines, routes, types, and import paths executable.
- Preserve foreign terms only at genuine adapter seams, such as WebRTC tracks,
  CallKit, or a provider's literal API vocabulary.
- Do not push, publish, deploy, or touch production.

## Definition of done

- Current public docs and marketing copy contain no banned platform vocabulary.
- Examples use `Space`, `Episode`, `Participant`, `SpaceClient`, `AccessGrant`,
  and `<Chalk />` consistently with the shipped code.
- Link and example checks, focused docs/app tests, formatting, the language
  ratchet, and the selected commit gate pass.
- Every user-visible string changed is listed in the handoff for copy review.
- Terra xhigh reports no unresolved P0/P1/P2 finding.
