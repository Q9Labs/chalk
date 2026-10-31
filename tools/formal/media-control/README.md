# Media on/off control model

A TLA+ model of how a device, Sync and an SFU keep one participant's microphone, camera and screen share on or off over unreliable networks. It checks the decided media control rule:

- Turning media off is the device's decision and never fails. The device stops capture at once, tells Sync, and resends until Sync shows it off. Sync accepts every off.
- Turning media on is Sync's decision. The UI shows pending until Sync shows the source live.
- After a reconnect, the device resends its offs and takes every on from Sync.

The same model also holds a switchable variant, `current`, that reproduces how the SDK handles reconnects today. The check finds a counterexample for `current` and none for `decided`.

## Result

Under the decided rule all four properties hold at the checked bounds, for the Cloudflare SFU and for an own SFU. The current SDK variant violates P2 and P4. The rows below come from `results/summary.md`, produced by `./run.sh`.

| Property | Meaning                                                                                                            | `decided` | `current`    |
| -------- | ------------------------------------------------------------------------------------------------------------------ | --------- | ------------ |
| P1       | A muted source never captures and nothing flows to the SFU, in any state, including during and after a reconnect   | holds     | holds        |
| P2       | An off is never lost across a reconnect: when the Sync link returns, every off Sync has not accepted is still owed | holds     | **violated** |
| P3       | The UI never shows on before Sync does                                                                             | holds     | holds        |
| P4       | After faults stop and delivery is fair, device and Sync agree again                                                | holds     | **violated** |

P1 and P3 hold for `current` because the SDK stops capture locally and shows on only from a Sync snapshot. The failure is purely an off that Sync never receives.

All 17 runs matched their expected outcome (`pass` or `violated`). Columns after `check` are the bounds: sources, revisions per source (`seq`), link drops, lost messages, host mutes, failed closes.

| run                         | check  | sources     | seq | drops | loss | mutes | cfails | rule      | ui    | sfu        | expect   | outcome  | states   | distinct | depth | seconds |
| --------------------------- | ------ | ----------- | --- | ----- | ---- | ----- | ------ | --------- | ----- | ---------- | -------- | -------- | -------- | -------- | ----- | ------- |
| cf-decided-safety-1src      | safety | mic         | 3   | 2     | 2    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 7165145  | 1176766  | 35    | 38      |
| cf-decided-live-1src        | P4     | mic         | 3   | 1     | 2    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 1660460  | 298666   | 31    | 41      |
| cf-decided-live-1src-d2     | P4     | mic         | 2   | 2     | 2    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 1328652  | 224087   | 31    | 29      |
| own-decided-safety-1src     | safety | mic         | 3   | 2     | 2    | 1     | 0      | decided   | FALSE | own        | pass     | pass     | 2096638  | 396511   | 31    | 12      |
| own-decided-live-1src       | P4     | mic         | 3   | 1     | 2    | 1     | 0      | decided   | FALSE | own        | pass     | pass     | 597155   | 119445   | 28    | 16      |
| cf-current-P2-1src          | P2     | mic         | 2   | 1     | 1    | 0     | 0      | current   | FALSE | cloudflare | violated | violated | 550      | 250      | 8     | 0       |
| cf-current-P4-1src          | P4     | mic         | 2   | 0     | 1    | 0     | 0      | current   | FALSE | cloudflare | violated | violated | 1128     | 362      | 15    | 1       |
| cf-current-P4-drop-1src     | P4     | mic         | 3   | 1     | 1    | 0     | 0      | current   | FALSE | cloudflare | violated | violated | 37604    | 8732     | 22    | 3       |
| cf-current-P1-1src          | P1     | mic         | 3   | 2     | 2    | 1     | 1      | current   | FALSE | cloudflare | pass     | pass     | 8807336  | 1474009  | 36    | 35      |
| cf-current-P3-1src          | P3     | mic         | 3   | 2     | 2    | 1     | 1      | current   | FALSE | cloudflare | pass     | pass     | 8807336  | 1474009  | 35    | 35      |
| mutant-adoptSync-P1         | P1     | mic         | 2   | 1     | 1    | 0     | 0      | adoptSync | FALSE | cloudflare | violated | violated | 2570     | 788      | 12    | 1       |
| mutant-optimisticUi-P3      | P3     | mic         | 1   | 0     | 0    | 0     | 0      | decided   | TRUE  | cloudflare | violated | violated | 2        | 2        | 2     | 1       |
| witness-on                  | W1     | mic         | 2   | 0     | 0    | 0     | 0      | decided   | FALSE | cloudflare | violated | violated | 136      | 48       | 13    | 1       |
| witness-hostmute            | W2     | mic         | 2   | 0     | 0    | 1     | 0      | decided   | FALSE | cloudflare | violated | violated | 819      | 261      | 11    | 0       |
| deep-cf-decided-live-2src   | P4     | mic,cam     | 1   | 1     | 1    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 2494203  | 342256   | 32    | 81      |
| deep-cf-decided-safety-2src | safety | mic,cam     | 2   | 1     | 1    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 46590684 | 5644562  | 40    | 240     |
| deep-cf-decided-safety-3src | safety | mic,cam,scr | 1   | 1     | 1    | 1     | 1      | decided   | FALSE | cloudflare | pass     | pass     | 41996446 | 4068999  | 44    | 293     |

## Counterexample for the current SDK

TLC's shortest violation of P4 (`results/cf-current-P4-1src.txt`, condensed with `node trace-diff.mjs results/cf-current-P4-1src.txt`) needs no reconnect at all:

1. The user turns the microphone on. The device sends `on` (revision 1).
2. The user turns it off. The device stops capture and sends `off` (revision 2).
3. The network loses the `off`.
4. The off command times out, and the SDK records it as failed.
5. Sync receives the late `on` and grants the microphone.
6. Sync sends its snapshot. The device applies it, still off.

The end state never changes: the device is off, Sync grants and shows the microphone on, and nothing resends the off.

TLC's shortest violation of P2 (`results/cf-current-P2-1src.txt`) adds the reconnect that the code skips: steps 1 to 4 above, then the Sync link drops and returns, and the failed off is neither queued nor sent. Replay it against the SDK like this:

1. Join a Space with a fake Sync port and turn the microphone on. Sync confirms and the snapshot shows the participant's microphone enabled.
2. Call `setMicrophoneEnabled(false)`. The track stops at once. Make `ports.sync.setMicrophoneEnabled(false)` reject while the connection stays live. `#failRevision` records `result = { status: "failed", cleanup: true }` (`sdks/typescript/client/src/space-client/media-controller.ts:476`).
3. Drop the Sync connection and reconnect. Serve a snapshot that still shows the participant's microphone enabled.
4. Observe that no second `setMicrophoneEnabled(false)` is sent. `#resumePendingActions` skips the source because `result.revision === desired.revision` (`sdks/typescript/client/src/space-client/media-controller.ts:702`); if the ports were unbound in between, `#resetObservations` turns the failed result into `confirmed` (`sdks/typescript/client/src/space-client/media-controller.ts:607`). Remote participants keep seeing the microphone as on.

The harness for this lives in `sdks/typescript/client/src/space-client/media-recovery-consent.test.ts` and its neighbours. The steps are written from the model and from reading the code on `origin/master` at `3f9fe4385`; no one has run them against the SDK yet.

## Recommended SDK fix

All paths are in `sdks/typescript/client/src/space-client/media-controller.ts` at `3f9fe4385`.

1. `:702` in `#resumePendingActions`: do not skip a source whose off failed. Change the condition to skip only when `desired.enabled` is true, or when the result matches the revision and is not a failed off that still needs cleanup:
   `const offOwed = !state.desired.enabled && state.result.status === "failed" && state.result.cleanup;` then `if (source !== "screen" && (state.desired.enabled || (state.result.revision === state.desired.revision && !offOwed))) continue;`
2. `:604-609` in `#resetObservations`: keep a failed off with `cleanup: true` instead of rewriting every result to `confirmed`, so an unbind during a reconnect does not forget it.
3. `:688` in `#reconcileIntents`, which runs on every Sync snapshot: add the mirror of `#pauseRecoveredIntents` (`:1157-1163`, which only handles device on and Sync off). When a source has `desired.enabled === false` and the participant's own item in `snapshot.media.items` is still `enabled`, run `#work` for that source again. This resends the off without a reconnect (the P4 trace above) and keeps the resend going until Sync shows it off.

Fixes 1 and 2 close P2. Fix 3 is what makes P4 hold when the link never drops.

## What the model covers

| Model                                  | Real system                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `want`, `seq`                          | `SourceWorker.desired` (`enabled`, `revision`)                                                                                        |
| `cap`                                  | local track enabled state (`#pauseTracks`, `localEnabled`)                                                                            |
| `offState`: `queued`, `sent`, `failed` | `SourceWorker.result`: work not yet run, command in flight, `status: "failed"` with `cleanup: true`                                   |
| `reconciled`                           | `#syncLive` and `#reconcileIntents`                                                                                                   |
| `view*`, `Ui`                          | the Sync snapshot's media items and `MediaSlice` pending state                                                                        |
| `grant`, `lastSeq`, `hostMute`         | Sync's live Episode: `apply_live_target`, `set_media_pause`, `reserve_publication_grant` (`apps/sync/lib/chalk_sync/live/episode.ex`) |
| `pubs`, `sess`, `sfuUp`                | the publication ledger behind the Go API (`apps/api/internal/adapters/cloudflare/sfu/adapter.go`) and the device's SFU session        |
| `intent`, `reconnected`                | ghosts that exist only to state the properties                                                                                        |

Faults: message loss, duplication and reordering on device to Sync and device to SFU, Sync-link drops, SFU-session drops with a rebuild (new session id), host mute and lift, failed SFU closes (Cloudflare only). Sources: any set of `Sources` (microphone, camera and screen share are interchangeable in the model; they share links and fault budgets).

Cloudflare today: a close is a separate call and can fail, a dead session's publications stay until closed or garbage-collected, and revoking a grant leaves the publication open until Sync closes it. The own SFU: closes cannot fail, a dead session's publications vanish, and revoking a grant removes the publication in the same step.

## What it proves and what it does not

- **Bounded.** TLC checked every behavior within the bounds in `runs.txt`: revisions per source (`MaxSeq`), link drops (`MaxDrops`), lost messages (`MaxLoss`), host mutes, failed closes. A bug that needs more events than the bounds allow is not found. The bounds are small on purpose; the counterexamples need only five to eight steps.
- **Channels keep the latest message of each kind per source.** A message can arrive again or after a newer one (duplication and reordering) and can be lost. A scenario where two messages of one kind are both in flight and both arrive in order, with the older one overtaking nothing, is folded into the sequential case. Receivers ignore anything not newer, so this loses no behavior the receivers could tell apart, but it is an abstraction.
- **Liveness assumes fairness.** After the fault budgets run out, repairs happen: resends, deliveries, snapshots, reconnects, SFU admits, closes and garbage collection are weakly fair. Loss, drops, host mutes and user actions get no fairness. This is the standard fair-lossy channel assumption; it says nothing about an outage that never ends.
- **Several sources** run only at the smaller `deep-*` bounds. Sources are symmetric in the model, and safety runs use TLC symmetry; liveness runs do not.
- **Sync ordering is assumed.** The model gives each device command a revision and has Sync ignore any command older than one it already accepted. The SDK sends command ids and compares control revisions; I did not verify that the Sync server orders a device's commands the same way.
- **An off with no publication.** In `apply_live_target`, an off for a source with no observed publication is confirmed without storing a pause. The model always stores the off. This path is not covered.
- **One participant, one device.** Other-device microphone handoff, screen leases, subscribers, recording, receive-side behavior and the media itself are out of scope. Timeouts are nondeterministic steps, not clocks.
- **Not connected to the code.** The model describes `origin/master` at `3f9fe4385` and is not tied to it by an executable test, so it cannot detect drift. A passing model does not prove the SDK. The counterexample steps above are the bridge: turn them into an SDK test, and the model's `decided` variant is what that test should satisfy.
- **Not in CI.** `./run.sh` runs by hand. The default set takes a few minutes; `DEEP=1` adds about 20 minutes.

## Run it

```sh
./run.sh                 # default runs, a few minutes
DEEP=1 ./run.sh          # plus the multi-source runs
./run.sh cf-current-P2-1src   # one run
node trace-diff.mjs results/cf-current-P2-1src.txt   # a counterexample, one line per step
```

It needs Java 11 or newer and `curl`. The first run downloads TLC (`tla2tools.jar`) into `~/.cache/chalk-tla/` and checks its SHA-256. The release URL is a moving tag, so the checksum in `run.sh` is what pins the tool; the results were produced with TLC 2026.10.30 (rev 090e85c). Each run writes its exact configuration to `results/<run>.cfg`, the TLC output to `results/<run>.txt` and a row to `results/summary.md`. The script exits non-zero if any run does not match its expectation in `runs.txt` (`pass` or `violated`).

Files:

- `MediaControl.tla`: device, Sync and network, the four properties, the reachability witnesses.
- `Sfu.tla`: the SFU, behind six operators.
- `runs.txt`: one row per run, with bounds, variant, SFU kind and expected outcome.
- `run.sh`, `trace-diff.mjs`: the runner and the trace condenser.
- `results/`: configs, TLC output and the summary.

## Swap the SFU

`MediaControl.tla` talks to the SFU only through `Sfu.tla` (`Pub`, `Admit`, `OnRevoke`, `OnSessionLost`, `Collectable`, `Closable`) and the actions `SfuAdmit`, `SyncCloseOk`, `SyncCloseFail`, `SfuGc`, `DropSfu` and `RebuildSfu`, which schedule those operators.

- To switch between the two SFUs already described, change the `sfu` column in `runs.txt` to `cloudflare` or `own`. `run.sh` maps that to the three constants `CloseCanFail`, `OrphansLinger` and `AtomicRevoke`.
- To model a different SFU, change the operators in `Sfu.tla`, or add constants to it. For example, an SFU that admits a publication without asking Sync for a grant is a change to the guard in `SfuAdmit`, and an SFU with its own session recovery is a change to `OnSessionLost` and `RebuildSfu`. Then rerun `./run.sh`; the properties do not mention the SFU.

## Variants and properties

`ReconnectRule` selects the device's reconnect behavior:

- `decided`: offs are resent until Sync acknowledges them, after every timeout and every reconnect.
- `current`: an off is sent once, when the user turns it off. A timeout marks it failed, and a failed off is never sent again. An off queued while offline is sent on reconnect.
- `adoptSync` (deliberately broken): the device turns a source back on when Sync still shows it on. P1 fails on it.

`OptimisticUi = TRUE` is the second deliberately broken variant: the UI shows on as soon as the user asks. P3 fails on it.

Reachability witnesses (`W1`, `W2`) are expected to be violated: the violation shows that turning on works end to end and that a host mute reaches the device, so the properties are not vacuous.

## Heal model: listener heal loop and dead-publication path

`MediaHeal.tla` answers a different question from `MediaControl.tla`: if a publisher keeps its microphone on, does every listener eventually hear it, even when tracks are lost at the SFU, pulls fail, and sessions drop and rebuild? `MediaControl.tla`, `Sfu.tla` and `runs.txt` are unchanged, and `run.sh` runs both models.

### What the model describes

The model describes `origin/master` at `3f9fe4385` plus three things that are not on master. Nothing here ties the model to the code by an executable test, so it cannot detect drift.

- On master: `#rememberRecoveryIntents` and `#pauseRecoveredIntents` in `sdks/typescript/client/src/space-client/media-controller.ts`; `apply_live_target`, `apply_media_pauses` and the `enabled` projection in `apps/sync/lib/chalk_sync/live/episode.ex`; the API's publication ledger in `apps/api/internal/mediapublications/`.
- From the #716 branch, not merged: the listener heal tick and the publisher's own stall detection in `sdks/typescript/client/src/media/client.ts` and the receive-stall module beside it.
- Planned, not in code: the server dead-publication path (the API counts failed pulls of a gone track, reports it dead to Sync, the publisher republishes). Master already has a different absence path in `apps/api/internal/mediapublications/reconciliation.go` (three observations at least 2 s apart plus a 15 s grace). The model describes the planned path, not that one.

Actors: the publisher (the decided on/off rules, reduced to one source), Sync (owns the publication list `none | on | off | dead` and its versions, and the grant), the API with the SFU (the ledger and the track set; a lost track may linger without packets), and listeners (the heal loop). Faults, each with a budget and no fairness: publisher track lost at the SFU, listener subscription lost, a refused pull, receive-connection loss, publisher Sync-link drop, SFU session rebuild, a lost message, and a host mute. A joint cap `MaxFaults` keeps combined faults small.

### Properties

- **P5src (liveness).** If the publisher keeps the microphone on, stays connected and is not host-muted from some point on, then every listener eventually has some live publication pulled with packets rising, with capture on, and stays so (`<>[]`). It is stated at the level of the microphone, not of one publication, so a dead path that only marks the publication dead cannot satisfy it by making the property vacuous.
- **P5 (liveness).** The same for each single publication that Sync keeps listed as on while its publisher stays connected.
- **P4h (liveness).** Faults stop, delivery is fair: publisher and Sync agree again on on/off.
- **S5c (liveness).** A pulled publication that Sync lists as off or dead is eventually dropped.
- **P1, P1b (safety).** Capture implies the user wants it; and only the user's own on turns capture on. No heal, republish or recovery step does.
- **P1d (liveness).** A host mute that Sync has applied stops capture, also when it arrives during a reconnect.
- **P2 (safety), P4h.** An off is never lost across a publisher reconnect; publisher and Sync agree again.
- **S5 (safety).** The heal loop pulls a publication only if its own roster lists it as on.
- **S5b (expected violated).** Against Sync itself the listener's roster can be older than Sync's, so a listener may pull a publication Sync already lists as dead. The heal loop cannot rule this out; the check records it.
- **P6 (safety).** Retry spacing stays within the cap. This is the check for the no-cap mutant, because without time eventual liveness does not depend on how long a backoff is.

### Fairness

Weak fairness only, on every repair step: deliveries, resends, reconnects, the heal tick (backoff, flat sample, drop, pull), the republish steps and SFU garbage collection. Faults, host mutes and user actions get none; their budgets bound them. Strong fairness is not needed: once faults stop, every repair step becomes enabled and stays enabled, so weak fairness already forces it. The model has no clock: a backoff, a flat sample count and a drop count stand for about 500 ms ticks.

### Recovery rule (found bug on master)

`#pauseRecoveredIntents` pauses a device after a reconnect when `snapshot.media.items[]` has no item for it with `enabled` true. In Sync, `enabled` is true only while the API observes a live publication for that participant and source; Sync also projects it to false while a pause is held (`apps/sync/lib/chalk_sync/live/episode.ex`). It is not the grant. So when the grant is on but no publication is listed yet (the first publish is in flight), or the dead path has just removed the publication, a reconnect pauses the device. The wanted state stays on, nothing turns capture back on, and listeners hear silence until the user toggles off and on. `heal-sdk-today-P5src` is that counterexample (`RecoveryPause="item"`, 12 states); `heal-witness-W5` shows the dead-path variant is reachable.

`RecoveryPause="grant"` is a proposed rule, not a tested fix: pause only when Sync has seen the remembered on-revision and its grant is off, which is what a moderation pause looks like. With it, every property holds, W4 (a device that wants capture but has none) is unreachable, and a host mute during a reconnect still stops capture (`heal-hostmute-grant-P1d`). `"none"` (never pause on recovery) loses the host mute (`heal-hostmute-none-P1d` is violated). Whether the real client can read the grant from a snapshot is open: the snapshot item does not carry it.

### Mutants

Each removes one mechanism and runs the same property set; the results are in `tools/formal/media-control/results/heal-summary.md`.

- No flat-packet drop and re-pull, no receive-session reconnect, no server dead path, give up after 2 failures: each breaks P5src.
- No SFU expiry of silent tracks breaks P5src unless the publisher also detects its own lost track (`heal-nogc-selfdetect-P5src` passes).
- **No retry cap does not break P5src.** Without time, a longer backoff only delays the pull; with finite faults it still happens. P6 (retry spacing at most the cap) is the check that breaks (`mutant-heal-nocap-P6`). The model does not prove anything about how long a listener waits.

### Bounds and what is not proved

Default bounds: one listener, four publication ids, two user actions, each fault kind at most once, at most two faults together. The `deep-heal-*` rows add three faults together and two listeners; their liveness rows use one user action so they fit in 8 GB. Liveness runs do not use symmetry. Not proved:

- Time. Backoff, the 7 s stall window, 30 s Cloudflare expiry and pending-publication timing are counters or absent. The model says nothing about how long a listener waits.
- More than two (three on the deep rows) faults together, more than two listeners, more than one source, camera, screen and recording.
- The planned dead path as built: the real thresholds and message formats are not known yet. Pulls in the real API do not check Sync's enabled state; the model's heal loop does (it pulls only what its roster lists as on).
- That the SDK or Sync implement any rule above. The model is not executable against the code.

### Run it

```sh
./run.sh                    # both models, default bounds
DEEP=1 ./run.sh             # plus the deep rows of both models
./run.sh heal-decided-P5src # one row
node trace-diff.mjs results/heal-sdk-today-P5src.txt   # the counterexample, one line per step
```

`heal-runs.txt` has one row per run: `name | check | expect | overrides`. The defaults are in `run.sh`; each run writes `results/<run>.cfg` and `results/<run>.txt`, and a full run writes `tools/formal/media-control/results/heal-summary.md`. The last full run was on an Instabox machine (4 vCPU, 8 GB).
