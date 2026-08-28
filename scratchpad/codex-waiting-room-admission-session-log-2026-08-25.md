# Waiting-room admission session log

## 2026-08-25: Production diagnosis

- Confirmed the reported production Space and diagnostic reference without changing production state.
- Public invite arrivals use the control-plane public-admission queue, while the in-Space Waiting tab only reads the sync admission queue. The dashboard also loaded the public queue only once, so neither live owner surface showed new arrivals reliably.
- Approval persisted an active Participant before the guest collected access. An admitted-arrival replay then called the proof-gated refresh path without media proof. The guest cannot hold that proof before entry, so access collection failed while the Participant remained active.
- Production records and diagnostics confirmed admitted arrivals with persisted Participants plus repeated access failures. Private identifiers, credentials, and raw production artifacts remain outside the repository.

## 2026-08-25: Repair direction

- Keep scheduled access refresh proof-gated.
- Add a separate authenticated restore path for an admitted arrival's existing Participant and provider binding.
- Project the public-admission queue into the in-Space Waiting UI for account-created Spaces and poll both owner surfaces with non-overlapping timers.
- Cover the restore boundary, live queue updates, decision routing, and cleanup with focused tests before the full gates.

## 2026-08-25: First dogfood pass

- Both SDK skins showed waiting arrivals and removed admitted or denied rows immediately.
- The zero-Participant state also said “No participants found,” which looked inconsistent beside visible waiting arrivals. The empty-roster copy now distinguishes an empty Space from an empty search result.
- The preview harness cannot exercise admission loading, custom names, or a programmatic narrow viewport, so those states remain covered only by static contracts and focused tests.

## 2026-08-25: Clean dogfood pass

- Repeated the zero-Participant waiting flow in Classic and Chalk after the copy fix. The queue remained clear, admit and deny removed rows immediately, and the final empty state was accurate.
- Durable screenshots are in `scratchpad/screenshots/`. They remain local and are excluded from the public commit.
- A real Helium interaction recording could not be captured: the Chrome plugin has no video API, macOS screen recording permission is unavailable, and Helium rejects Apple Events. No synthetic slideshow was substituted for real proof.

## 2026-08-25: Gate repair

- The full gate exposed an existing client lifecycle test whose fixed access expiration had passed earlier in the day. The fixture now derives an expiration one hour from test execution while keeping the Episode start time fixed, so the test checks the intended projection instead of the wall clock.
- The focused Go, web, React, client, trace, and language checks passed. The API gate and canonical `pnpm run gate` also passed on the remote M4 Mac mini.

## 2026-08-25: Review fix

- The bounded branch review found that a failed dashboard admission decision reached the Waiting UI as an unhandled promise rejection. Both skins now show a retryable error supplied by the account admission control, keep the arrival visible, and record one structured decision-failure diagnostic.
- Focused Space tests plus web and React type checks pass after the fix. The canonical remote gate also passes with the review fix included.

## 2026-08-25: Re-review fixes

- The bounded re-review found that account admission polling still ran for open Spaces, where no owner decision can be required. The account admission control now activates only when the Space admission mode is `knock`.
- Bulk admit and deny actions shared an action-wide browser retry key, so concurrent decisions could overwrite each other's retry identity. Each key is now scoped by action and request handle, which keeps retries stable and independent.
- Focused Space and dashboard API tests plus web, React, and language checks pass after both fixes.
- The final clean remote smart gate passed after running the mobile app's documented diagnostics-contract prebuild. The initial clean run exposed that missing build artifact rather than a source failure.

## 2026-08-28: Master reconciliation and final review

- Reconciled the combined branch with current `master` and removed half of the newly added tests. The retained boundaries killed targeted mutations for provider restore, persisted participant identity, polling cleanup, approval removal, and failed-decision visibility.
- The final branch review found three release blockers: RTK recovery did not retain its original meeting, non-managers polled the admission API, and dashboard retry updated the wrong reload signal.
- Public arrivals now persist the provider Episode reference through a reversible migration, recovery reuses that exact reference, polling requires `manageAdmission`, and retry triggers the admission poll. Each fix kills its matching mutation, and the migration passed an isolated up/down/up cycle.
