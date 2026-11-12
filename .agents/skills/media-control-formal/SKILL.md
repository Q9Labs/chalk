---
name: media-control-formal
description: 'Model-check media on/off control with TLA+: the device, Sync and the SFU keep one microphone, camera or screen share on or off over lossy networks, and a heal model for listeners. Use when a change touches sdks/typescript/client/src/space-client/media-controller.ts (offDebt, failed or pending media revisions, resend after reconnect), when the "Media control model" CI check fails, or to prove an on/off ordering bug.'
---

# Media on/off control model

One participant turns a microphone, camera or screen share on or off. The device, Sync and the SFU each hold a part of that decision, and the network can drop, delay and lose messages between them. `tools/formal/media-control/` holds two TLA+ models of it. Read `tools/formal/media-control/README.md` first: it holds the full property table, the counterexamples and the bounds.

| Rule | Plain sentence                                                                               | Harm when it breaks                                                      |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| P1   | A muted source never captures and nothing flows to the SFU, in any state.                    | Other people hear or see you after you muted.                            |
| P2   | An off is never lost across a reconnect: every off that Sync has not accepted is still owed. | Sync keeps a source on that you turned off.                              |
| P3   | The UI never shows "on" before Sync does.                                                    | You think you are live while nobody gets your media.                     |
| P4   | After faults stop and delivery is fair, the device and Sync agree again.                     | The two disagree for ever, with your microphone on at Sync and off here. |

`MediaHeal.tla` asks a second question: if a publisher keeps the microphone on, does every listener eventually hear it, even when tracks are lost at the SFU. It has its own rows in `heal-runs.txt`.

## What the code does today

The model has two reconnect rules for the device. `decided` is the rule the product chose: an off is the device's decision and never fails, and the device resends it until Sync shows it off. `current` is the earlier SDK behavior: a failed off is neither queued nor sent after a reconnect. The SDK has since moved to `decided`: the `offDebt` field (`none | owed | sent`, `sdks/typescript/client/src/space-client/media-controller.ts:30`) shipped in commits `b04e6211f` and `f65821627`. So the `current` rows are a record of the pre-fix behavior. Their P2 and P4 counterexamples describe code that no longer exists, and they stay in `runs.txt` to prove that the check can still find those bugs. Treat the `decided` rows as the ones that describe the code.

## Does my change touch the model?

```sh
git diff --stat 941d5710deeddb444ef904519bf2a792f608fd36 -- sdks/typescript/client/src/space-client/media-controller.ts
```

If the diff changes how an off is sent, how a failed or refused revision is settled, or what is resent after a reconnect, read it against the model. Other changes, such as device selection or screen-share capture, do not touch it.

## Coverage record

Sync commit: `941d5710deeddb444ef904519bf2a792f608fd36`. Nothing ties the model to the code by a test: there is no `anchors` file for it, so drift is found only by this review. Move the commit forward only after reading the functions below at the new commit.

All paths are under `sdks/typescript/client/src/space-client/`.

- The `OffDebt` type and the `offDebt` field (`sdks/typescript/client/src/space-client/media-controller.ts:30`, `:38`) with the comment at `:48` to `:57` are the model's owed off. A user off makes it `owed` (`:514`, `:1534`), Sync accepting an off makes it `sent` (`:601`, `:613`), Sync showing the source off or accepting a newer on makes it `none` (`:962`), and a `sent` off that a snapshot still shows on becomes `owed` again (`:944`). A failed on, a reset and a reconnect leave it alone. This is the `decided` rule.
- `#failRevision` (`:620`) settles a refused or timed-out revision.
- `#resumePendingActions` (`:930`) and `#rememberRecoveryIntents` (`:1478`) are the reconnect resend: the device resends its offs and takes every on from Sync.
- `CameraState` (`:105`) and `#transitionCamera` (`:1054`) are the local capture stop that P1 relies on.
- The UI state shown as pending until a Sync snapshot shows the source on is P3.

The Sync side (`apps/sync/lib/chalk_sync/live/episode.ex`, `apply_live_target`, `apply_media_pauses`) and the SFU side (the API's publication ledger) are in the model but not covered by any check here.

## Run the check

```sh
tools/formal/media-control/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4) once into `~/.cache/chalk-tla`. The full run has 17 `runs.txt` rows and 33 `heal-runs.txt` rows and takes about 15 minutes. The script exits non-zero if any row's outcome differs from the `pass` or `violated` in its table.

CI runs a bounded subset in `.github/workflows/formal-media-control.yml`. the run script takes row names, and then it does not overwrite the summary files:

```sh
tools/formal/media-control/run.sh cf-decided-safety-1src own-decided-safety-1src cf-current-P2-1src cf-current-P4-1src cf-current-P4-drop-1src mutant-adoptSync-P1 mutant-optimisticUi-P3 witness-on witness-hostmute
```

The subset covers: P1 to P3 on the decided rule for both SFUs, the `current` P2 and P4 counterexamples, the two broken variants that must break P1 and P3, and the two witnesses that show "on" is reachable. The slow P4 live rows (`*-live-*`) and `heal-*` rows run in the full local run only. Run those locally when a change touches the resend path or the heal loop.

`DEEP=1 tools/formal/media-control/run.sh` also runs the `deep-*` rows with several sources (about 20 minutes more).

## Replay against the real code

The existing tests drive the real media controller through the same orderings as the counterexamples:

```sh
cd sdks/typescript/client && pnpm exec vitest run src/space-client/media-off-owed.test.ts src/space-client/media-off-resend.test.ts src/space-client/media-off-ordering.test.ts
```

A failing `decided` row is a finding. Replay its steps in a new case in those files with the fake Sync and SFU clients. If the replay does not show the bug, the model is wrong: find the step whose guard differs from the code.

## Read a failure

Give the TLC output to `node tools/formal/media-control/trace-diff.mjs results/<row>.txt`. It prints the steps as changes between states. Use the `/statechart` skill if you need a chart of the model.

**A `decided` row now fails.** Replay it. If the replay shows the bug, report it with the steps in plain words. Do not weaken a property.

**A `current` row now passes.** The model of the old rule drifted. These rows are historic, but a change to `MediaControl.tla` that makes them pass has probably removed a guard that matters to `decided` too.

**A mutant row now passes.** The check lost its power: the guard that the mutant removes no longer matters. Find the action that lost a condition.

**A witness row now passes.** The state that a property talks about is no longer reachable, so the property proves nothing. Fix the model first.

## Change the model on purpose

1. Change the action in `MediaControl.tla` (or `MediaHeal.tla`) to say what the new code does.
2. Update the README sections that describe it.
3. Run the full the run script locally. All rows must meet their expectation. The committed `results/` files are regenerated by a full run, and only a full run should update them.
4. Move the sync commit in this file.

## What the model leaves out

- Time. Timeouts, resend delays and the SFU's absence detection are "any time later".
- One participant and, in the normal rows, one source. The multi-source rows are `deep-*`.
- The media client itself: peer connections, codecs, device selection, the screen share picker. The model sees only on, off, publish and unpublish.
- Camera and screen share specifics in `CameraState`. They are checked as another source with the same rules.
- The connection lifecycle that decides when the link drops and returns. `client-recovery-formal` covers that. This model treats drops as a budget (`MaxDrops`).
- The heal model includes parts that are not on master: the listener heal tick and the publisher's stall detection (branch #716) and a planned server dead-publication path. The README lists them. Its result holds for that design, not for what runs today.
- Versions of the TLC tool: the committed `results/` files came from a newer TLC build than the pinned v1.7.4. State counts differ for the heal model, the outcomes do not.
