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

`result.json` records the tested source hashes. `baseline-451.txt` records #400's different winners for the six arrival orders.
`source-hashes.json` covers all 32 implementation files copied to the M4, including the generated contract and tests.
The proof-only files in this directory do not change those runtime sources.
Run `node docs/proofs/follow-view-owner/count-lines.mjs <head>` to compare the two proposals.
The direct comparison includes unrelated changes on master between the proposals. Binary assets do not contribute line counts.

Run the owner cases from the repository root without installing the Sync application's dependencies:

```sh
ERL_FLAGS='+S 1:1' elixir docs/proofs/follow-view-owner/run-owner-tests.exs
```

The delayed-relay regression failed in both negotiated and legacy modes before the owner tracked the active publisher.
After another tab's real move to x=20, the old owner accepted an idle relay to x=11 with sequence 3.
Both cases expected no new frame: 7 of 9 tests passed before the fix, and all 9 pass after it.
The owner now keeps one active publishing stream per person.
Only a real move or an explicit Follow selection changes that stream; an idle tab cannot reclaim it.
The browser journey caught this when a published 5.1.0 tab brought everyone while its other tab still followed the host.
Legacy clients without input IDs use geometry and epoch heuristics rather than new-protocol retry IDs.

Reproduce that red result with the earlier owner and the current tests:

```sh
git show 1dc90d4335d37f371edcb9c1aa29bc4a1323e9d1:apps/sync/lib/chalk_sync/whiteboard_v1/view_owner.ex > /tmp/chalk-follow-owner-before.ex
ERL_FLAGS='+S 1:1' elixir docs/proofs/follow-view-owner/run-owner-tests.exs /tmp/chalk-follow-owner-before.ex
```

The final M4 Sync gate passed 212 tests with two topology cases excluded, strict Credo, and warnings-as-errors compilation.
All ten selected app lanes passed: scope, format, hygiene, secrets, generated files, contracts, types, tests, build, and depcruise.
Performance lanes were not selected. The job and browser journey both exited zero.
