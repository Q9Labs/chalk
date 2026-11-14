---
name: episode-lifecycle-formal
description: 'Model-check the Episode lifecycle and admission with TLA+. Use when a change touches how an Episode ends (host End, maximum duration, deadline changes), how joins, knock admissions or Leaves behave around an end, the DeadlineScheduler, or the end path in apps/sync external_operation_finalizer.ex, external_operation_planner.ex, lifecycle.ex, or episode_control.go and episode_lifecycle_create.go in apps/api, when CI''s "Episode lifecycle model" check fails, or to prove an Episode end bug.'
---

# Episode lifecycle and admission model

A Chalk Episode ends in several ways: a host presses End, the maximum duration passes, or a deadline change replaces the old limit. Each way runs as separate Postgres transactions, and a join, a knock decision or a Leave can land between them. Tests reach these orderings only by luck, because each needs an API call, a scheduler cycle, a consumer pass and a finalizer to land in a specific order.

`tools/formal/episode-lifecycle/EpisodeLifecycle.tla` models those steps and checks five rules in every order they can happen in.

| Rule                     | Plain sentence                                                                                                        | Harm when it breaks                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `NoPersonLiveAfterEnd`   | No person is joining, active or leaving in an ended Episode.                                                          | A person looks present in a call that is over: the roster, attendance and billing count them, and their client believes the call still runs. |
| `EndClearsPending`       | When an Episode ends, no join intent and no knock request is still pending.                                           | A late join or a host's Admit applies to an ended Episode, or a knocker waits on a request nobody answers.                                   |
| `AdmissionDecidedOnce`   | A knock request leaves `pending` at most once.                                                                        | A person is admitted and turned away for the same knock, or two hosts' decisions both apply, and the roster and the webhook disagree.        |
| `StaleDeadlineCannotEnd` | The Episode ends for the maximum duration only through the operation for the deadline generation it has when it ends. | A host extends the time limit and an old end operation still ends the call at the old limit.                                                 |
| `PastDeadlineGetsEnd`    | A passed deadline always has an end on the way or a retry coming.                                                     | An end that failed leaves the Episode running past its maximum duration, and only a host can end it.                                         |

## Findings

No rule is broken today. `findings` is empty, and `tools/formal/episode-lifecycle/run.sh` still checks every rule listed in it.

`PastDeadlineGetsEnd` was a finding: `ClaimDueEpisodeDeadlines` skipped every Episode with a `maximum_episode_duration_expired` operation for the current deadline generation, whatever its status, so an end that failed 100 times (`restore_episode_active`) was never tried again. The claim now skips only an operation that has not failed. A failed one allows a new operation, keyed `maximum-duration-<generation>-retry-<n>`, after a backoff of 1, 2, 4 ... 60 minutes (the model leaves the backoff out). The `failed_end_blocks_claim` variant restores the old behavior.

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 98385cafd771ec4ea6d0cbd876eb5e4cdc43c7e1 -- apps/api/internal/adapters/postgres/episode_lifecycle_create.go apps/api/internal/adapters/postgres/episode_control.go apps/api/db/queries/sync_lifecycle.sql apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/lifecycle.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex apps/sync/lib/chalk_sync/external_operation_consumer.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions, such as recording or chat code in the same file, needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `98385cafd771ec4ea6d0cbd876eb5e4cdc43c7e1`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

- `AdmitParticipant`, `RequestKnock`: `apps/api/internal/adapters/postgres/episode_lifecycle_create.go` (`AdmitParticipant` returns `ErrEpisodeNotActive` unless the Episode is `active`) and `apps/api/internal/adapters/postgres/public_episode_admission.go` (the knock request).
- `ApplyJoin`: `apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex` (`transaction`, `validate_lifecycle_product_state`).
- `ReserveDecision`, `FinalizeDecision`, `ReleaseDecision`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex` and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex` (`reserve_admission_decision`, `reserve_admission_request`), `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex` (`finalize_admission_request`, `finalize_admission_approval`, `complete_denied_admission_product`, `release_failed_acceptance`).
- `AcceptLeave`, `FinalizeLeave`, `FailLeave`, `SettleObsoleteLeave`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex` (`validate_leave_acceptance`, `mark_operation_participant_leaving`), `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`complete_external_participant`, `restore_participant_active`, `settle_obsolete`).
- `DeadlineDue`, `SetDeadline`, `FinalizeDeadline`: `apps/api/internal/adapters/postgres/episode_control.go` (`SetDeadline`) and `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`validate_finalization_deadline`, `update_deadline_product`).
- `EnqueueMaximumDuration`: `apps/api/db/queries/sync_lifecycle.sql` (`ClaimDueEpisodeDeadlines`) and `apps/api/internal/adapters/postgres/episode_control.go` (`EnqueueDueEpisodeDeadlines`, `createEndReadyOperation`).
- `AcceptUserEnd`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex` (`prepare_end_operation`, `mark_operation_episode_ending`).
- `CompleteEnd`, `RejectStaleEnd`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`complete_external_episode`, `complete_episode_participants`, `stale_maximum_duration?`, `settle_stale_maximum_duration`) and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/lifecycle.ex`, `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex` (`supersede_pending_lifecycle_intents`, `complete_external_episode_admissions`).
- `EndRetriesExhausted`: `apps/sync/lib/chalk_sync/external_operation_consumer.ex` (`execute_operation`, `@max_attempts`) and `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`restore_episode_active`).

Each action is one Postgres transaction under the Episode control row lock (`Authority.lock_control`, `for update`) and then the Episode row lock, in that order on the Sync side and on the API side. If a change splits one of these transactions, or moves a read out from under the locks, the model's atomic step is wrong and must be split too.

`tools/formal/episode-lifecycle/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/episode-lifecycle/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes under a minute. It does four things, and fails if any one fails:

1. It checks that every fragment in `anchors` is still in its file.
2. It runs TLC on `EpisodeLifecycle.cfg` (2 people, 2 deadline generations, `Break = "none"`), which is the real code, and needs every rule to hold.
3. It checks each rule in `findings` (none today) and needs TLC to report it as broken, so a fixed finding does not go unnoticed.
4. It runs each broken variant in `breaks`, and needs TLC to report the named rule as broken. This proves the check can still fail.

The full TLC logs go to the folder that the last line prints. CI runs `tools/formal/episode-lifecycle/run.sh` in `.github/workflows/formal-episode-lifecycle.yml` when a covered file or this model changes.

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/episode-lifecycle/EpisodeLifecycle.view.mjs` as the view, with a config of one person (`People = {a}`, `MaxGen = 1`) so that the chart stays small. It turns a violation into the shortest path in plain words. When everything passes, it draws how an Episode moves between "Running", "Ending" and "Ended" while a person moves between "Joining", "In the call" and "Left".

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `EpisodeLifecycle.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A rule breaks on `Break = "none"`.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug. Each step maps to one transaction, so a replay is a throwaway Postgres session or a Postgres-backed test that drives those transactions in that order (run it on Instabox). If the replay shows the bug, report it with the path in Chalk's words and add the rule to `findings` until it is fixed. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the step.

**A finding is reported as fixed.** `tools/formal/episode-lifecycle/run.sh` says the rule no longer breaks. Move the rule into `INVARIANTS` of `EpisodeLifecycle.cfg` and delete its line from `findings`.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `breaks` line before you change anything. Do not delete the variant.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `EpisodeLifecycle.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard, and the rule it protects.
4. Run `tools/formal/episode-lifecycle/run.sh`. All rules must hold on the real code and every variant must break.
5. Move the sync commit in this file to the commit you checked, and update the coverage record.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- One generation per person. A rejoin after a Leave, entry generations and the Leave ordering of one person's sockets are covered by `sync-entry-leave-formal`, not here.
- Time as a set of facts: `due` says the current deadline has passed, and the 5-minute knock lifetime is modeled as always possible. Clock values, the scheduler's polling interval and the order of two Episodes are not modeled.
- The 100-attempt exhaustion is modeled for the end operation only. Other operations (a decision, a Leave) fail by one failure step.
- Host removal (`remove_participant`), media-plane effects of an end (room close, recording stop, webhooks) and the API's participant-lease expiry are not modeled.
- Consumer nodes, claim leases and crashes are not modeled. A step either happens or it does not.
- Bounds: 2 people and 2 deadline generations on every run. The statechart uses 1 person.
