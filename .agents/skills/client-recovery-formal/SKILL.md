---
name: client-recovery-formal
description: 'Model-check the SDK connection lifecycle with TLA+: join, Sync and media recovery, access refresh, terminal frames and Leave. Use when a change touches sdks/typescript/client/src/connection/lifecycle.ts (recover, recoveryPlan, finishRecovery, performLeave, refreshAccess, settleTerminalSnapshot), access/manager.ts or the Sync client phases in sync/v1-client.ts, when CI''s "Client connection recovery model" check fails, or to prove a reconnect ordering bug.'
---

# Client connection and recovery model

A Chalk client keeps two links alive: Sync (the call state) and media (audio and video). Either link can drop at any moment, and while the app recovers it, you can press Leave, the server can end the call or remove you, and your access grant can age. The lifecycle (`ConnectionLifecycle`) serves all of this from one actor queue: it takes one item at a time, and a recovery fiber and a refresh fiber enqueue their results into the same queue. Tests reach the bad orderings only by luck, because each one needs a link event, a timer and a user action to land in a given order.

`tools/formal/client-recovery/ClientRecovery.tla` keeps that queue in order and checks these rules in every order the events can land in:

| Rule                    | Plain sentence                                                                                                                        | Harm when it breaks                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LeaveNotUndone`        | Once Leave has started, the Connection stays leaving or left until the next join.                                                     | A late recovery pulls a person back into a call they left.                                               |
| `NoAbandonedRecovery`   | Whenever the lifecycle has handled everything it was told and Sync or media is down, a recovery is pending.                           | The call sits "live" with a dead link and nothing tries to heal it.                                      |
| `EndingIsFinal`         | A terminal `episode_ended` or removal frame ends the call at once: left, nothing running, nothing to reconnect.                       | A client that was removed or whose call ended keeps dialing Sync and media.                              |
| `RemovalReported`       | A removal the lifecycle saw is reported as `removedByHost`, whichever way the call ended.                                             | The app tells a removed person that the network failed.                                                  |
| `RevokedGrantNotLive`   | A grant the server rejected never leaves the client live.                                                                             | The client keeps a call it no longer has access to.                                                      |
| `RecoveryEnds`          | A recovery that is under way ends: live again, failed or left. With `SyncMayDie`, a Sync that never returns ends the Connection.      | The app shows "reconnecting" for ever, and the person never learns to rejoin.                            |
| `NoRestartWhileLeaving` | Once Leave has started, no recovery attempt asks for a new Sync token or a new media connection. (Broken today, finding F2.)          | A Leave that waits for its acknowledgement keeps spending access requests and opening media connections. |
| `ExpiredGrantNotLive`   | A grant that ran out because the refresh kept failing never leaves the Connection live. (Broken today, finding F3, perhaps intended.) | The Connection claims to be live and shows no failure, while the next command that needs access fails.   |

`TypeOK` also runs on every state.

## Findings

Each one is a row in `runs` that must stay `violated` until the code changes, with the suggested fix as a row that must pass, and a replay against the real lifecycle in `sdks/typescript/client/src/connection/recovery-model-replay.test.ts`. The replay is an `it.fails` test, so it passes while the bug exists. When someone fixes the code, the test fails and tells them to drop `.fails`, and the `runs` row has to move from `violated` to `pass`.

**F1, a media blip downgrades a Sync recovery** (`finding-sync-downgrade`). `recover(kind)` at `sdks/typescript/client/src/connection/lifecycle.ts:688` overwrites `recoveryQueued` with the newest kind. Steps: Sync goes down and never comes back; the app starts a Sync recovery; audio and video blip before the quiet period ends; the queued kind becomes `media`; the recovery cycle plans a media try. A media plan reports `media_recovery_exhausted` and retries in the background without ever failing the Connection, so the person stays on "reconnecting" for ever. With the two events in the other order, the plan stays a sync plan and the Connection fails with `sync_recovery_exhausted`. The recovery loop still waits for Sync in every try, so the downgrade changes only what happens at the end. The fix that passes `fix-sync-wins` is to keep `recoveryQueued = "sync"` when a media event arrives.

**F2, a recovery attempt keeps going during Leave** (`finding-restart-in-leave`). Steps: media is recovering, so a recovery attempt waits for it; you press Leave; Sync is slow to acknowledge it; media fails. `recoverMedia` and `restartSync` never look at the Connection state, so the waiting attempt's next round calls `access.refresh("media_recovery", true)` and `media.restart()` while the Connection is leaving. Only `replaceMediaConnection` checks for Leave. The replay sees `media.restart` called and access requested while the state is still `leaving`. The fix that passes `fix-leave-stops` is to end the recovery fiber when Leave starts.

**F3, live on a grant that ran out** (`finding-expired-grant`, may be intended). Steps: the refresh keeps failing with "unavailable"; the grant runs out. `refreshAccess` retries with a back-off and leaves the state `live` with `failure: null`. The next command that needs access fails. Decide whether `live` should turn into `reconnecting` or a failure once the grant runs out.

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 941d5710deeddb444ef904519bf2a792f608fd36 -- sdks/typescript/client/src/connection/lifecycle.ts sdks/typescript/client/src/access/manager.ts sdks/typescript/client/src/sync/v1-client.ts sdks/typescript/client/src/media/client.ts
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions, such as diagnostics or the join trace, needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `941d5710deeddb444ef904519bf2a792f608fd36`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

All paths are under `sdks/typescript/client/src/`.

- `Active`: `sdks/typescript/client/src/connection/lifecycle.ts` (`active`).
- `UserJoin`, `ProcessJoin`, `JoinSucceeds`, `JoinFails`: `performJoin`. The model keeps only the new epoch, the new clients and the media recovery that `join` starts when media is not live.
- `UserLeave`, `ProcessLeave`, `LeaveEnds`: `performLeave` and `leaveIsConfirmed`. The model ends Leave in `left` and does not distinguish a confirmed from an unconfirmed Leave.
- `StopPorts`: `stopPorts`, which clears `recoveryQueued`, closes the scope (this ends the recovery and refresh fibers), stops the clients and clears the grant.
- `ProcessSnapS`: `handleSyncSnapshot`, `settleTerminalSnapshot`, `finishTerminalSnapshot`, `syncTerminalFailure`, `syncNeedsRecovery`.
- `ProcessSnapM`: `handleMediaSnapshot`, `mediaNeedsRecovery`.
- `RecoverPost`: `recover`. This is where F1 lives (`RqRule`).
- `FiberGrace`, `ProcessRec`, `PlanCycle`, `AfterExh`, `BackoffWakes`: the body of the fiber that `recover` forks, with `recoveryPlan` and `waitForTransportChange`.
- `AttemptSeesSync`, `AttemptSeesMedia`, `AttemptRestartMedia`, `AttemptRestartSync`, `AttemptSucceeds`, `AttemptFatal`, `AttemptExhausted`: `attemptRecovery`, `recoveryOperation`, `recoverSync`, `recoverMedia`, `restartSync`, `syncNeedsReplacement`. Both `recoverSync` and `recoverMedia` run in every try, whatever the plan kind.
- `ProcessFin`: `finishRecovery`. `ProcessFail`: the `failForSnapshot` branch of the loop. `ProcessExh`: the exhaustion handler in the loop. `ProcessRest`: the enqueue inside `restartSync`.
- `GrantAges`, `RefreshStarts`, `RefreshReturns`, `ProcessRefr`: `scheduleRefresh`, `refreshAccess` and `sdks/typescript/client/src/access/manager.ts` (`millisecondsUntilRefresh`, the expiry check on a grant).
- `SyncDials` to `MediaFails`: the Sync client phases in `sdks/typescript/client/src/sync/v1-client.ts` (`idle`, `connecting`, `recovering`, `live`, `terminal`, `stopped`; the model calls the authenticating step `recovering`) and the media phases (`idle`, `connecting`, `live`, `recovering`, `failed`).

`tools/formal/client-recovery/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/client-recovery/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes about a minute on a 10-core machine. It fails if any of these fail:

1. Every fragment in `anchors` is still in its file.
2. The `real-*` rows pass: every rule holds on the real code.
3. The `finding-*` rows still report their rule as broken, and the `fix-*` rows pass.
4. Each `break-*` row breaks the rule it names. This proves the check can still fail.

`tools/formal/client-recovery/run.sh finding-restart-in-leave` runs one row. The full TLC logs go to the folder that the last line prints. Each row is one TLC run with its own bounds, because the fault budgets multiply, so each row stays small.

CI runs the same script in `.github/workflows/formal-client-recovery.yml` when a covered file or this model changes.

The replay tests run with the package's tests:

```sh
cd sdks/typescript/client && pnpm exec vitest run src/connection/recovery-model-replay.test.ts
```

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/client-recovery/ClientRecovery.view.mjs` as the view so that states and steps use the words of a person in the call. The chart budget is 500 states, so write a small config for the chart. These bounds (`MaxSyncFaults MaxMediaFaults MaxTerminal MaxRefreshFaults MaxLeaves SyncMayDie`) give one chart each:

| Chart                                  | Bounds        | What it draws                                     |
| -------------------------------------- | ------------- | ------------------------------------------------- |
| a link drops and recovers              | `1 0 0 0 0 F` | The whole recovery loop, all rules hold.          |
| the call ends or you are removed       | `0 0 1 0 0 F` | Final frames, `EndingIsFinal`, `RemovalReported`. |
| F2, recovery restarts during Leave     | `0 0 1 0 1 F` | The bug path to `NoRestartWhileLeaving`.          |
| F3, live on a grant that ran out       | `0 0 0 1 0 F` | The bug path to `ExpiredGrantNotLive`.            |
| F1, Sync gone for good, `RecoveryEnds` | `1 1 0 0 0 T` | The counterexample for `SPECIFICATION LiveSpec`.  |

Use the `ClientRecovery.cfg` constants with those bounds, add `NoRestartWhileLeaving` and `ExpiredGrantNotLive` to its `INVARIANTS` for the F2 and F3 charts, and use `LiveSpec` with `PROPERTY RecoveryEnds` for F1.

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `ClientRecovery.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A real-code row fails.** Tell the path as `/statechart` gives it, then replay it against the real lifecycle before you call it a bug: add a case to `sdks/typescript/client/src/connection/recovery-model-replay.test.ts` that drives the same events through the fake Sync and media clients in `sdks/typescript/client/src/space-client/core.test.helpers.ts`, with the manual clock. If the replay shows the bug, report it with the path in Chalk's words and leave the rule as it is. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the model.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `runs` row before you change anything. Do not delete the variant.

**A finding row now passes.** The code changed in a way that fixes it. Confirm with the replay test, change the row in `runs` to `pass`, drop `.fails` from the test, and move the finding out of this file.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `ClientRecovery.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a `break-*` row with a `Break` value that removes the guard, and the rule it protects.
4. Run `tools/formal/client-recovery/run.sh`. All rows must meet their expectation.
5. Move the sync commit in this file to the commit you checked, and update the coverage record.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- Time. Backoff, the 250 ms quiet period, the 60 second budget and the Leave timeout are all "any time later". A recovery try may run out only after it has restarted a failed media or a terminal Sync that may recover, and not while both links are live.
- One join. `MaxEpoch = 1` in every row, so a rejoin after Leave, after a failure or after the call ends is not checked. `epoch` still guards stale queue items.
- What happens inside the Sync client and the media client. The model sees their phase only. Sync's own reconnect, receipts, and the SFU are left out. A Sync that dies for good is a switch (`SyncMayDie`).
- The access grant is a four-step age (`fresh`, `stale`, `expired`, `revoked`). The contents of tokens, media connection replacement (`replaceMediaConnection`, the 409 superseded path, `refreshAfterRejection`) and automatic media replacement are not modeled. A grant can expire only after a refresh failed, because the refresh fiber wakes before the window closes.
- The join path. `JoinFails` happens at any time, and `access_retry`, `cancelPendingAdmission`, the Episode status check and the initial media start are not modeled.
- A Leave with an unconfirmed acknowledgement ends in `left` in the model. `closed` (dispose) is not modeled.
- One recovery fiber and one refresh fiber at a time. Snapshot items on the queue are coalesced to one of each kind, because the handler reads the latest state.
- The foreground deadline and tab visibility rules in `recoverMedia` and `recoverSync`.
- `sdks/typescript/client/src/space-client/reload-rejoin.ts` (the reload marker) and `sdks/typescript/client/src/space-client/offline-actions.ts` (actions queued while offline) sit above this lifecycle and are not covered.
- The media controller (`sdks/typescript/client/src/space-client/media-controller.ts`) is covered by `media-control-formal`.
- Bounds are one fault of each kind per row (see `runs`).
