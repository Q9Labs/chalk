---
name: screen-share-lease-formal
description: 'Model-check the screen-share lease with TLA+. Use when a change touches ScreenShareLease (acquire, renew, release), the lease handling or media observation cursor in live/episode.ex, the coordinator''s live reconcile interval, or the lease timings in apps/sync, when CI''s "Screen-share lease model" check fails, or to prove a screen-share lease bug.'
---

# Screen-share lease model

One Chalk Episode allows one screen share at a time. A lease row in `sync_screen_share_leases` (one row per Episode) says who may share. `Live.Episode` acquires the lease before it asks the media plane to publish a screen, renews it while it follows the plane's observations, and releases it when the share ends. The renewal window is 20 seconds, the hard cap is 30 seconds, and the coordinator looks at the plane every 15 seconds. Tests reach the bad orderings only by luck, because each needs a clock, a media observation, a Leave and a failed database call to land in a specific order.

`tools/formal/screen-share-lease/ScreenShareLease.tla` models those steps for two people and checks five rules in every order they can happen in.

| Rule                    | Plain sentence                                                                                                                          | Harm when it breaks                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `NoTakeoverWhileLive`   | A lease that is still live is never taken by another owner.                                                                             | Two people share at once, or the person who shares loses the lease while they still run.                                 |
| `LeaseNeedsAuthority`   | A lease is acquired or renewed only for the participant generation that is authorised at that moment.                                   | A person who left, or an old tab, keeps a screen-share lease alive and blocks the next sharer.                           |
| `NewestObservationWins` | `Live.Episode`'s projection of the media plane is the newest observation it ever applied: an older cursor never overwrites a newer one. | A late snapshot makes the call show a share that ended, or hides one that runs, and the lease follows the wrong picture. |
| `AtMostOneShare`        | At most one participant in the call has a screen publication.                                                                           | Two people share at once, and the next observation stops with `{:error, :conflicting_screen_publications}`.              |
| `ReshareGetsFullLease`  | A new share gets a lease with a full hard cap, so a person whose share ended does not inherit the old cap.                              | A share ends early because a failed release left the old lease in place.                                                 |

## Findings

No rule is broken today. `findings` is empty, and `tools/formal/screen-share-lease/run.sh` still checks every rule listed in it. Both rules below were findings and the code now holds them:

- `AtMostOneShare`: the coordinator looks at the plane every 15 seconds. A look at an unchanged cursor now renews the lease (`apply_equal_media_observation` reconciles the leases), the renewal window is 20 seconds so it outlasts the 15-second look interval, and a lease whose hard cap ends before the next look is replaced while the share runs (`renew_screen_lease`, `ScreenShareLease.outlasts_renewal?`). The variants `equal_look_skips_renew`, `short_renewal` and `hard_cap_lapses` restore each old behavior.
- `ReshareGetsFullLease`: `Live.Episode` ignores a failed release (`_ = release_screen_lease(...)`) and forgets the lease, so the row stays. A share that starts without a lease in memory now replaces the owner's old row (`:replace_own` in `acquire`), with a new lease id and a full hard cap. The variant `reshare_inherits` restores the old behavior.

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 98385cafd771ec4ea6d0cbd876eb5e4cdc43c7e1 -- apps/sync/lib/chalk_sync/live/screen_share_lease.ex apps/sync/lib/chalk_sync/live/episode.ex apps/sync/lib/chalk_sync/episodes/coordinator.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions, such as recording or chat code in the same file, needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `98385cafd771ec4ea6d0cbd876eb5e4cdc43c7e1`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

- `Acquire`, `Renew`, `Release`: `apps/sync/lib/chalk_sync/live/screen_share_lease.ex` (`acquire` with `acquire_query`, `own_live_lease` and `keeps_lease`, `renew`, `outlasts_renewal?`, `release`). The row is an upsert on (tenant, episode). The same active owner keeps the lease id and the hard cap, unless the caller starts a new share (`:replace_own`).
- `Time`: `@default_renewal_ms` (20 s) and `@default_hard_lifetime_ms` (30 s) in `apps/sync/lib/chalk_sync/live/screen_share_lease.ex`, and `@live_reconcile_interval_ms` (15 s) in `apps/sync/lib/chalk_sync/episodes/coordinator.ex`.
- `EnableScreen`: `apps/sync/lib/chalk_sync/live/episode.ex` (`enable_reserved_publication` for `:screen`, `acquire_screen_lease`, `retain_or_release_screen_lease`).
- `StopCommand`: `apps/sync/lib/chalk_sync/live/episode.ex` (`maybe_release_screen_lease`).
- `Observe`, `Look`, `Conflict`: `apps/sync/lib/chalk_sync/live/episode.ex` (`apply_media_observation`, `compare_media_cursor`, `apply_equal_media_observation`, `apply_newer_media_observation`, `reconcile_screen_leases`).
- `Handle`, `Observed`, `Rel`: `apps/sync/lib/chalk_sync/live/episode.ex` (`reconcile_observed_screen_lease`, `renew_screen_lease`, `rotate_screen_lease`, `acquire_observed_screen_lease`, `release_absent_screen_leases`, `release_and_forget_screen_lease`, `release_screen_lease`).
- `Join`, `Leave`, `ClientStops`: the participant authority generation that `reconcile_observed_screen_lease` reads, and the media plane dropping a publication. Their code is outside this model.

Each Live.Episode step is one `GenServer` call. The lease row changes in its own Postgres transaction, so a failed pass leaves the row changed and the memory unchanged, and the model keeps that split. If a change makes a pass atomic or moves a lease write after the memory update, the model's step is wrong and must change too.

`tools/formal/screen-share-lease/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/screen-share-lease/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes about a minute (131,021 distinct states). It does four things, and fails if any one fails:

1. It checks that every fragment in `anchors` is still in its file.
2. It runs TLC on `ScreenShareLease.cfg` (2 people, 1 generation each, time in 5-second units up to 25 seconds, `Break = "none"`), which is the real code, and needs every rule to hold.
3. It checks each rule in `findings` (none today) and needs TLC to report it as broken, so a fixed finding does not go unnoticed.
4. It runs each broken variant in `breaks`, and needs TLC to report the named rule as broken. This proves the check can still fail.

The full TLC logs go to the folder that the last line prints. CI runs `tools/formal/screen-share-lease/run.sh` in `.github/workflows/formal-screen-share-lease.yml` when a covered file or this model changes.

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/screen-share-lease/ScreenShareLease.view.mjs` as the view, with small bounds (`Horizon = 2`, `Renew = 2`, `Hard = 3`, `Every = 3`, `MaxSeq = 2`, `MaxLid = 2`) so that the chart stays small. It turns a violation into the shortest path in plain words.

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `ScreenShareLease.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A rule breaks on `Break = "none"`.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug. A replay is a throwaway Postgres-backed test that drives `Live.Episode` with the media-plane test adapter, moves the clock by changing the lease row's timestamps, and forces the release to fail by holding a row lock (run it on Instabox). If the replay shows the bug, report it with the path in Chalk's words and add the rule to `findings` until it is fixed. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the step.

**A finding is reported as fixed.** `tools/formal/screen-share-lease/run.sh` says the rule no longer breaks. Move the rule into `INVARIANTS` of `ScreenShareLease.cfg` and delete its line from `findings`.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `breaks` line before you change anything. Do not delete the variant.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `ScreenShareLease.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard, and the rule it protects.
4. Run `tools/formal/screen-share-lease/run.sh`. All rules must hold on the real code and every variant must break.
5. Move the sync commit in this file to the commit you checked, and update the coverage record.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- Two people with one generation each. A rejoin with a new generation is covered only by the authority check in `Handle`.
- Time in 5-second units, and the hard cap as 25 seconds instead of 30, to keep the state space small. Time passes only after `Live.Episode` applied the plane's newest observation, so a delivery that takes more than 5 seconds is not modeled.
- A new observation always is the plane's newest. A late delivery of a snapshot newer than the last applied one but older than the plane's newest is not modeled. A repeat or an older cursor is.
- The media plane as a set of publications with a cursor. Provider calls, track pausing (the model runs `StopCommand` only after the plane dropped the share), the grant failing for reasons other than a terminal error, and incarnation changes of the cursor are not modeled.
- A leave drops the authority at once and the plane drops the publication later. The finalizer's `stop_participant_screen_share`, which deletes the lease, is not modeled.
- Several Episodes, several `Live.Episode` processes for one Episode and a node crash.
- The `acquiring` state that the table constraint allows is never written, so it is not modeled.
- Bounds: 131,021 distinct states on every run.
