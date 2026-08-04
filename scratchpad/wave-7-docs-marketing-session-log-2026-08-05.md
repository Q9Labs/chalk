# Wave 7 docs and marketing session log

## 2026-08-05 00:32:43 PKT

- Read the Wave 7 prompt, execution brief, `GLOSSARY.md`, and the writing-style guide before editing.
- Audited the owned public docs. `apps/docs/` is not present in this checkout, so no app-doc files were available to update.
- Rewrote the root README, design guidance, north-star model, observability guidance, camera-background prompt, video-background prompt, and sound-design vocabulary around Space, Episode, Participant, SpaceClient, AccessGrant, and `<Chalk />`.
- Left `GLOSSARY.md` unchanged because it is the ratified vocabulary source and its old terms appear only in the explicit banned-term and replacement tables.
- Kept code, app marketing metadata, generated files, historical scratchpad material, and adapter-owned vocabulary outside this worktree's ownership.

## 2026-08-05 00:35:17 PKT

- `oxfmt --check` passes for all 12 owned Markdown inputs when run from the repository's installed binary.
- The Markdown link check passes for all 10 tracked Markdown docs under `docs/` plus `README.md`; every relative target exists.
- The language ratchet reports only expected decreases: `docs` reaches zero for meeting, conference, room, session, and lobby; root drops one room and one session from the README. The committed baseline still needs the repository owner to run `pnpm run language:ratchet:update` after all waves.
- The new north-star TypeScript example imports `GetAccess` and `Chalk` from their shipped packages. The existing web quickstart's imports, `SpaceClient` controllers, `<Chalk />` props, and event callback names were checked against the current SDK source.
- Remaining implementation seams are outside this ownership: generated/API fixtures and product inventory still carry pre-Wave-7 names, and `apps/docs/` is absent from this checkout. These were not edited.

## 2026-08-05 00:44:57 PKT

- Closed Terra findings in the owned docs: telemetry now states that tenant API keys are rejected and that only Episode-scoped media-access bearers or authenticated User identity bearers/cookies are accepted; the north-star constraints restore optional Redis acceleration and standard Postgres without vendor-specific database dependence; Tenant/Space ownership is explicit; the design roster layer says Participants; and the sound guide contains no em-dashes.
- Re-ran formatting, local-link, banned-term, and diff checks. Formatting, links, the owned zero-count scan, the em-dash scan, and `git diff --check` pass. The full ratchet still reports only the expected baseline decreases recorded above.

## 2026-08-05 00:50:14 PKT

- Corrected telemetry auth wording to the actual accepted credential paths: a verified RealtimeKit/provider Participant bearer or an authenticated User credential presented as a bearer or cookie. Tenant API keys are rejected before authentication, and Chalk-signed media grants plus `AccessGrant` envelopes are not accepted by the intake route.
- Re-ran `oxfmt --check` on all 12 owned Markdown files, the local Markdown-link check, the owned zero-count language scan, and `git diff --check`: all pass. The concurrent `apps/web/src/routes/sdk-preview.tsx` edit remains untouched.

## 2026-08-05 00:51:08 PKT

- Terra's final re-review P1 is closed with no further docs findings requested. The final credential wording names the verified RealtimeKit/provider Participant bearer and the authenticated User bearer/cookie path, while excluding tenant API keys, Chalk-signed media grants, and `AccessGrant` envelopes.
- Ran `pnpm run language:ratchet:update`, then `pnpm run language:ratchet`: both complete successfully. The baseline diff is limited to `tools/language-ratchet/baseline.json`: `docs` meeting/conference/room/session/lobby are now 0; root room/session decrease only to 52/55. No other baseline surface changed.
- Final verification remains green: oxfmt, local links, owned banned-term scan, em-dash scan, and `git diff --check` pass. No files were staged or committed.
