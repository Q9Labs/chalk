# Whiteboard focus and persistence session log

Date: 2026-08-19

## Decision

- Board presentation is shared Space state, not a local React toggle. Sync stores the presenting Episode on the current scene and broadcasts `presentation_updated` to every participant.
- A Board presented in one Episode cannot leak into a later Episode. Closing hides the Board for everyone without changing its scene.
- While presented, the Board is the primary Stage content even if a screen share is active.
- The collaboration engine flushes its final debounced drawing update when the Board unmounts, including when another submission is still in flight.

## Focused proof

- Whiteboard engine: 6 tests passed, including immediate-close and in-flight close flushes.
- Client transport/controller: 6 tests passed for protocol presentation state and Space snapshot projection.
- React: 39 focused tests passed for shared presentation, subscription lifetime, and Stage priority.
- Sync: 9 focused tests passed with one database-backed test skipped until the isolated database gate.
- Generated whiteboard contract: byte-identical TypeScript and Elixir outputs; 5 focused codegen tests passed.
- Release metadata: SDK 4.1.5 is clear on npm, the frozen lockfile is current, and all 12 npm release-contract tests passed.
- Isolated M4 database proof: migration up/down/up passed; the repository test passed; all 14 focused Sync Whiteboard tests passed; and a final down/up after a committed presentation receipt removed the receipt, restored the old constraint, then restored the presentation column and expanded constraint.
- Canonical staged gate: one frozen install and one automatic `pnpm run gate` passed on the M4 in 263 seconds with the exact 65-path release diff.

## Browser setup blocker

- The supported local front door initially failed because broker discovery assumed only one local broker and route discovery assumed `/space` directly imported the React SDK. Both assumptions had drifted; focused launcher tests now cover both broker configs plus the indirect `/space` route.
- The Redis helper pinned the unavailable `redis:8.8.0-alpine` image. It now uses the current official `redis:8.10.0-alpine` image.
- OrbStack stalled before Redis, API, Sync, or Web became ready, including a retry with an already-cached Redis image. No browser product claim, screenshot, or recording was made from that failed setup. The spawned runtimes and named containers were stopped and removed.

## Remaining release steps

- Complete the two-participant browser pass against the exact deployed revision because the local container runtime could not boot the stack.
- Review the verified commit, push it, and deploy the approved SDK/web/managed release.

## Review repair

- The bounded review found two release blockers before push: adding `presenting` to the strict legacy welcome would disconnect 4.1.4 clients, and presentation fanout could stay stale on another Sync node after a missed PostgreSQL notification.
- The wire now keeps the exact legacy hello/welcome and requires an explicit `presentation_v1` extension before the server sends presentation state or frames.
- Presentation changes now advance the durable scene revision, store their boolean value in operation receipts, publish the durable head, and replay in revision order. Duplicate operation IDs return the original receipt value.
- Focused proof covers both legacy and negotiated codecs, legacy socket filtering, revisioned client state, and durable replay after a missed live notification. Client/contract type checks and Sync warnings/Credo are green.
- The fresh M4 database proof passed the migration up/down/up cycle, all 16 focused Sync Whiteboard tests, ordered update/presentation replay, false close receipts, and original-value idempotency.
- The exact 21-path review-repair patch then passed one frozen install and one canonical automatic gate in 259 seconds with task-isolated Go caches.

## Re-review repair

- The one bounded re-review found four rolling-upgrade and recovery gaps: PostgreSQL can name the previous unnamed receipt constraints with or without a `1` suffix; a 4.1.5 client needed a one-shot legacy hello fallback for an older Sync server; a replay-gap snapshot could leave presentation state stale; and the new public transport command needed to stay optional for custom 4.1.4 implementations.
- The migration now accepts both constraint-name histories. A disposable PostgreSQL proof passed up/down/up from both shapes and accepted true and false presentation receipts.
- The client now retries one legacy hello after an extended hello is rejected. Negotiated replay gaps reconnect for a fresh welcome before rebuilding the snapshot, so presentation state is repaired with the scene. The React SDK only exposes the Board toggle when a transport implements the optional presentation command.
- Focused client and React tests passed with 8 and 3 tests respectively, and both package type checks passed. No third review was run.
- The first final-gate attempt stopped on duplicated reconnect-test setup and disconnect-function complexity. A shared test factory and smaller disconnect helpers removed both findings; the focused client suite, client type check, formatting, and changed-code analysis then passed.

## Production repair

- SDK 4.1.5, web, API, and Sync shipped from one exact release SHA with green packed-consumer, npm, and deployment workflows.
- The first live pass exposed schema drift: managed deployment promoted API and Sync without applying the release migration, while readiness still accepted the older database. Applying the single pending migration with the dedicated owner credential restored Whiteboard connectivity and healthy SFU polling.
- Managed releases now derive their migration target from the release migration set, run an embedded one-shot migrator before API and Sync activation, keep its credential out of both runtimes, and fail readiness when the database is behind. Controller rollback remains forward-only for schema changes.
- The next live pass exposed a detached `setPresentation` class method. The React SDK now calls it through the transport receiver, and its regression test fails when that receiver is lost.
- SDK 4.1.6 carries the transport binding repair. Focused React, release-contract, Go migrator, API readiness, Sync readiness, and managed controller/configuration tests pass before the final gate.
