# Follow view owner proof

The journey uses real Sync, PostgreSQL, the current SDK, React Board, and Excalidraw on the M4.
Two Chromium instances act as host and follower. A second host tab shares the host's person ID.
The lane's M4 verification was already running when the machine policy changed.
It continued under the existing-lane exception in the approvals file and the lead's direct-run rule.
Local server ports are 3970–3972.

The contact sheet places the first followed move on the left and the recovered session on the right.
The rows show the host and follower. These are states of the changed code, not screenshots of #400.
The recording places the host and follower side by side throughout the journey.
This is the real Board in a small test host, not the full call UI.

The journey checks follower reconnect during a move, idle tab refreshes, a real move from each tab, and owner process death.
It also checks the published 5.1.0 package in both directions and rejects an own-Bring echo to that older client.
Published 5.0.0 completes its drawing snapshot. That release has no Follow-view capability.

`result.json` records the tested source hashes at `ec4b58874fe7b725f2d3e0e32c1e37b64c43c393`, before the behavior-preserving fallow cleanup.
`baseline-451.txt` records #400's different winners for the six arrival orders.
`source-hashes.json` covers all 32 implementation files copied to the M4, including the generated contract and tests.
Compare each proposal against its own base with Git's built-in line counts:

```sh
git diff --shortstat c48de517a309d34cd1c625a9ee1402348951f0a4 18f216766acac609b5570a9baba1acc17a19b93d
git diff --shortstat ebfa2b706dfadff5905e5ce34b4668abdf942da9 HEAD
git diff --shortstat 18f216766acac609b5570a9baba1acc17a19b93d HEAD
```

The direct comparison includes unrelated changes on master between the proposals. Binary assets do not contribute line counts.

Run the owner cases through the Sync application's normal test setup:

```sh
cd apps/sync
MIX_ENV=test mix test test/chalk_sync/whiteboard_v1/view_owner_test.exs
```

The delayed-relay regression failed in both negotiated and legacy modes before the owner tracked the active publisher.
After another tab's real move to x=20, the old owner accepted an idle relay to x=11 with sequence 3.
Both cases expected no new frame: 7 of 9 tests passed before the fix, and all 9 pass after it.
The owner now keeps one active publishing stream per person.
Only a real move or an explicit Follow selection changes that stream; an idle tab cannot reclaim it.
The browser journey caught this when a published 5.1.0 tab brought everyone while its other tab still followed the host.
Legacy clients without input IDs use geometry and epoch heuristics rather than new-protocol retry IDs.

The final M4 Sync gate passed 212 tests with two topology cases excluded, strict Credo, and warnings-as-errors compilation.
All ten selected app lanes passed: scope, format, hygiene, secrets, generated files, contracts, types, tests, build, and depcruise.
Performance lanes were not selected. The job and browser journey both exited zero.

## Review-round regressions

The revised source preserves the connect diagnostics merged in #457.
Admission uses the reducer's canonical 500-person limit. Departed sockets retire identities from admission without deleting bounded retry receipts.
The focused owner suite also fills all 1,024 input slots and updates an existing relay at capacity.
Owner-capable sockets acknowledge accepted input IDs, including retries; legacy sockets never receive the acknowledgment frame.
The client retains the original real-move frame until acknowledgment and resends that exact ID after reconnect.
Direct `sendView` callers lead by default; only explicit `lead: false` refreshes are passive.
Animated zoom publishes its final real rectangle. The Board regression checks a follower reaches the leader's final logical width of 0.8.
Self-person and legacy Bring frames bypass ordinary self-echo suppression.

Public event variants match the published 5.1.0 release. The existing drawing snapshot boundary clears Board view caches and replays fresh passive views.
The exhaustive consumer below compiles against both published 5.1.0 declarations and declarations emitted from the revised source.
The pre-fix unions fail the same `never` assignment because they contain `views_reset`.

```ts
import type { ChalkWhiteboardV1Event } from "@q9labsai/chalk-client";
import type { WhiteboardCollaborationEvent } from "@q9labsai/chalk-whiteboard";

export function consume(event: ChalkWhiteboardV1Event | WhiteboardCollaborationEvent): string {
  switch (event.type) {
    case "snapshot":
    case "update":
    case "cursor":
    case "view":
    case "reset_required":
      return event.type;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
```

The current PostgreSQL verification uses `box run -- '<command>'` on Instabox.
To keep one final Git push, the harness checks out pushed master, applies the unpublished patch, and verifies each source hash before testing.
The original M4 recording above remains evidence for ec4b58874, not a recording of this revised source.

## Draw-policy rebase compatibility

The schema and both protocol emitters retain draw-policy negotiation together with owner-aware Follow. The socket hello matrix covers the actual published 5.1.0 extension tuple and the current combined tuple, including the initial access refresh and a subsequent permission change. A client rejected for the owner extension first retries the #428 draw-policy hello; it removes drawing policy only after that hello is also refused. Authentication rejections still retry at the same level.

Negotiated `view_ack` and `draw_access` controls are decoded inside the connection. The public decoder retains the published 5.1.0 frame variants; an exhaustive decoded-frame consumer compiles alongside the two high-level event consumers.

An owner killed while a view call is pending closes the socket with 1012 and the `view_owner_restarted` terminal reason. A replacement owner starts with a fresh ID and snapshot.
