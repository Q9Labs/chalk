---
name: sync-entry-leave-formal
description: 'Model-check Sync entry admission and Leave ordering with TLA+. Use when a change touches entry generations, Leave acceptance, Leave deferral or supersede, or the local-lane Leave consumer in apps/sync (join_seats.ex, external_operation_planner.ex, external_operation_finalizer.ex, external_operation_consumer.ex, lifecycle.ex, external_operation_claims.ex), when CI''s "Sync entry and Leave model" check fails, or to prove a Leave ordering bug.'
---

# Sync entry and Leave ordering model

One person in a Chalk Episode can have several sockets: a second device, a reloaded tab, or a reconnect. Each socket entry gets an entry generation from `participant_join_seats`. Only the newest confirmed entry may Leave. A newer issued entry defers that Leave for its 2-minute issue lease, a newer confirmed entry supersedes it, and once Sync claims the Leave no new entry is issued. Tests reach these orderings only by luck, because each one needs a Leave, an entry claim, a lease expiry and a consumer pass to land in a specific order across separate transactions.

`tools/formal/sync-entry-leave/EntryLeave.tla` models those steps and checks four rules in every order they can happen in:

| Rule                           | Plain sentence                                                                                                         | Harm when it breaks                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LeftOnlyByNewestEntry`        | A person is marked left only by a Leave from their newest confirmed entry, and no newer entry is confirmed after that. | A reloaded tab or second device thinks it is in the call while the roster, attendance and the `participant.left` webhook say the person left, and leave cleanup removes their media. |
| `CancelledOnlyByNewerEntry`    | A Leave is cancelled only because a newer entry of the same person was confirmed.                                      | Someone who pressed Leave stays in the call for no reason.                                                                                                                           |
| `LeavingOnlyWhileLeavePending` | The person shows as leaving exactly while a Leave is pending.                                                          | The person is stuck as leaving: they cannot Leave again and nothing finishes it.                                                                                                     |
| `LeaveEnds`                    | Every accepted Leave ends, applied or superseded, when time passes and some node keeps retrying.                       | The person who pressed Leave stays in the roster and their client waits on the receipt.                                                                                              |

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 6e82e8f40a65c8d8d4c60daa2922cb6a65faa734 -- apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex apps/sync/lib/chalk_sync/external_operation_consumer.ex apps/sync/lib/chalk_sync/stateholder/postgres.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions, such as recording or chat code in the same file, needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `6e82e8f40a65c8d8d4c60daa2922cb6a65faa734`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

| Model action        | File                                                                                | Functions                                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdmitNewEntry`     | `apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex`                       | `admit_entry`, `allocate_entry`, `validate_entry_dispatch`                                                                                                                                  |
| `AdmitNewEntry`     | `apps/sync/lib/chalk_sync/stateholder/postgres.ex`                                  | `admit_entry`                                                                                                                                                                               |
| `IssueLeaseExpires` | `apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex`                       | `allocate_entry` sets `participant_join_seats.issued_entry_expires_at` to 120 seconds                                                                                                       |
| `ClaimEntry`        | `apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex`                        | `transaction`                                                                                                                                                                               |
| `ClaimEntry`        | `apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex`                       | `claim_entry`                                                                                                                                                                               |
| `AcceptLeave`       | `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex`       | `accept_transaction`, `prepare_operation` (`:participant_leave`), `validate_leave_acceptance`, `persist_operation_acceptance`, `mark_operation_participant_leaving`, `finalize_local_leave` |
| `AcceptLeave`       | `apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex`                       | `validate_leave`, `prepare_leave`                                                                                                                                                           |
| `AcceptLeave`       | `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex`   | `mark_participant_leaving`                                                                                                                                                                  |
| `ConsumerClaim`     | `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex`    | `claim_local_operations`, `claim_operations_where`                                                                                                                                          |
| `ConsumerPrepare`   | `apps/sync/lib/chalk_sync/external_operation_consumer.ex`                           | `execute_operation`, `dispatch_with_context`, `prepare_entry_leave`                                                                                                                         |
| `ConsumerPrepare`   | `apps/sync/lib/chalk_sync/stateholder/postgres.ex`                                  | `prepare_entry_leave`                                                                                                                                                                       |
| `ConsumerPrepare`   | `apps/sync/lib/chalk_sync/stateholder/postgres/join_seats.ex`                       | `prepare_leave`                                                                                                                                                                             |
| `ConsumerFinalize`  | `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex`     | `finalize_transaction`, `finalize_pending_operation` (`:participant_leave`, `{:confirmed, :local}`), `finalize_external_fact`, `complete_external_participant`                              |
| `ConsumerFinalize`  | `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex` | `complete_external_participant`                                                                                                                                                             |
| `ConsumerAbandons`  | `apps/sync/lib/chalk_sync/stateholder/postgres.ex`                                  | `prepare_entry_leave` maps errors to `:pending`; a node crash, a timeout or a failed transaction also abandons a claim                                                                      |

Each action is one Postgres transaction under the Episode control row lock (`Authority.lock_control`, `for update`). The one exception is `ConsumerClaim`, which locks only the operation row (`for update skip locked`) and writes only `attempt_count` and the 60-second claim lease. `AdmitNewEntry` reads that count under the control lock, so a claim that commits mid-admission orders the same as one that commits after it. If a change splits one of these transactions, or moves a read out from under the control lock, the model's atomic step is wrong and must be split too.

`tools/formal/sync-entry-leave/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/sync-entry-leave/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes about 10 seconds on a laptop. It does three things, and fails if any one fails:

1. It checks that every fragment in `anchors` is still in its file.
2. It runs TLC on `EntryLeave.cfg` (3 entry generations, 2 consumer nodes, `Break = "none"`), which is the real code, and needs every rule to hold.
3. It runs each broken variant in `breaks`, and needs TLC to report the named rule as broken. This proves the check can still fail.

`run.sh --deep` adds 5 entry generations and 3 consumer nodes, a few seconds more. The full TLC logs go to the folder that the last line prints.

CI runs `tools/formal/sync-entry-leave/run.sh` in `.github/workflows/formal-sync-entry-leave.yml` when a covered file or this model changes.

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/sync-entry-leave/EntryLeave.view.mjs` as the view so that states and steps use the words of a person in the call. It turns a violation into the shortest path in plain words. When everything passes, it draws how a person moves between "In the call", "Leave waits for the newer tab", "Leave finishing" and "Left".

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `EntryLeave.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A rule breaks on `Break = "none"`.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug. Each step maps to one transaction, so a replay is a test in `apps/sync/test/chalk_sync/` that drives those transactions in that order against Postgres (see `apps/sync/test/chalk_sync/entry_interleavings_postgres_test.exs` and `apps/sync/test/chalk_sync/durable_leave_postgres_test.exs`, run on Instabox). If the replay shows the bug, report it with the path in Chalk's words and leave the rule as it is. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the step.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `breaks` line before you change anything. Do not delete the variant.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `EntryLeave.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard, and the rule it protects.
4. Run `tools/formal/sync-entry-leave/run.sh`. All rules must hold on the real code and every variant must break.
5. Move the sync commit in this file to the commit you checked, and update the coverage record.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- One participant generation. A rejoin after Leave (a new generation) and leave cleanup's media fences (`remove_participant` with `departureOperationId`, `PublicationFences`) are not modeled.
- Entry ownership in enforced mode. Compatibility mode (`sync_entry_rollout.enforced = false`, entry generation `nil`) is not modeled.
- The person starts joined with entry 1 confirmed. Admission requests, the `joining` state, `reconcile_applied_join` and legacy seats are not modeled.
- Host removal (`remove_participant`), Episode end, and the API's participant-lease expiry are not modeled. They also mark a person leaving or left.
- The issue lease is one boolean that time can turn off and a new entry turns on. The 100-attempt exhaustion of a Leave is left out, because once Sync claims a Leave no entry can refresh the 120-second lease, so a deferred Leave becomes ready long before 100 claims of 60 seconds each.
- Consumer nodes may claim the same Leave at any time, which covers a page that outlasts the 60-second claim lease.
- Bounds: 3 entry generations and 2 consumer nodes on every run, and 5 and 3 with `--deep`.
