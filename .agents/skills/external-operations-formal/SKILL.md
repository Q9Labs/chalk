---
name: external-operations-formal
description: 'Model-check the Sync external-operation queue with TLA+. Use when a change touches role transitions (role_transition_source_stop), publication grants or fences, remove_participant or end-Episode operations, the operation claim query, or the provider-lane consumer in apps/sync (external_operation_consumer.ex, external_operation_finalizer.ex, publication_grants.ex, role_transition_planner.ex, role_transition_settlement.ex, external_operation_claims.ex), when CI''s "Sync external-operation model" check fails, or to prove a bug where a person keeps publishing after a host took it away.'
---

# Sync external-operation queue model

When a host removes someone, ends an Episode, or takes publishAudio away from a speaker, Sync writes a row in `sync_external_operations` and a provider-lane consumer on some Sync node tells the SFU to switch the source off. The speaker's own Live Episode process can ask for the same source at the same time (reserve a grant, call the SFU, complete it). These steps run in separate transactions, a node can stop between any two of them, and the SFU can answer late or not at all. Tests reach the bad orders only by luck.

`tools/formal/external-operations/ExternalOperations.tla` models one participant with one source (the microphone) and checks six rules in every order the steps can happen in:

| Rule                                   | Plain sentence                                                                                                      | Harm when it breaks                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `RemovedNeverPublishes`                | A removed participant has no live source at the SFU.                                                                | Someone the host removed is still heard or seen in the call.                                                 |
| `EndedNeverPublishes`                  | An ended Episode has no live source at the SFU.                                                                     | Media keeps flowing in an Episode that is over.                                                              |
| `DemotedPublishesOnlyWhileCleanupRuns` | A participant who lost publishAudio publishes only while the cleanup the role change started is pending, or failed. | A listener keeps speaking after the host made them an observer, with no operation left that would stop them. |
| `GivingUpLeavesNothingLive`            | When Sync gives up on a role-transition cleanup, nothing is left live.                                              | After 100 unclear answers Sync marks the stop failed and the source stays live for good.                     |
| `AppliedOnce`                          | The finalizer applies an operation at most once.                                                                    | Two nodes that finish the same operation run its effects twice.                                              |
| `OperationsSettle`                     | An operation that stays pending settles, applied or failed, even when the SFU never gives a clear answer.           | An operation stays pending forever and the host's action never completes.                                    |

## Findings

The model found three bugs in the real code, and all three are fixed. Each is kept as a broken variant in `tools/formal/external-operations/breaks`, so the check proves it would catch the bug again, and each has a regression test in `apps/sync/test/chalk_sync/external_operations_findings_test.exs`.

- **F-A, `DemotedPublishesOnlyWhileCleanupRuns`.** A speaker who is publishing asks for a second grant. While that request is open a host takes publishAudio away, which starts a source-stop child. The SFU refuses the second grant. `complete_publication_grant` sees a failed grant that needs cleanup and settles the pending child as applied without calling the SFU. The first grant is still live and nothing will revoke it. Fix: the child stays pending and revokes the first grant (variant `grant_settles_stop`).
- **F-B, `GivingUpLeavesNothingLive`.** A host takes publishAudio away from a speaker who is publishing. The SFU gives no clear answer to the source stop for 100 attempts, so Sync fails the child with `retry_exhausted`. The role change stays committed, the child is failed and the SFU still holds the source. Fix: a source stop never gives up. It stays pending and is retried until the SFU confirms, because the role change has already taken effect (variant `rt_gives_up`). A stop whose target is gone settles as applied.
- **F-C, `DemotedPublishesOnlyWhileCleanupRuns`.** The Live Episode process reserves a grant and stops before it calls the SFU. The reservation expires. A host takes publishAudio away, and Sync sees an expired reservation and no live source, so it starts no cleanup. The restarted process asks again with the same operation id, gets the expired row back, and the SFU grants the source. The speaker publishes without publishAudio and `complete_publication_grant` only reports `cleanup_required`. Fix: the reservation lookup skips an open row that has expired, so the insert replaces it with a new row and a new revision, which `assign_roles` then sees (variant `resend_expired`).

Run the regression tests with `cd apps/sync && scripts/with-reliability-postgres bash -c 'cd apps/sync && mix test test/chalk_sync/external_operations_findings_test.exs'` from the repository root (Elixir and Docker).

Because a source stop never gives up, `OperationsSettle` for it assumes the SFU answers a source stop it receives often enough (strong fairness on `HearsAnswer`). If the SFU never answers, the stop stays pending and every attempt logs a warning.

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 99ed21f87b1b6f1aac3b216980223ac614866810 -- apps/sync/lib/chalk_sync/external_operation_consumer.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_settlement.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/role_transition_planner.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `99ed21f87b1b6f1aac3b216980223ac614866810`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches.

- `Reserve`: `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex` (`reserve_transaction`, `validate_capability`) and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex` (the reservation insert with a 30-second expiry and the on-conflict overwrite that applies only to an expired row).
- `ResendGrant`: `reserve_transaction` in `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex` returns the existing row for a known operation id, whatever its status, except an open row that has expired (the lookup in `apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex` skips it, so the insert replaces it).
- `CompleteGrant`: `complete_transaction` in `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex`, and the completion update in `apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex` that extends the reservation to at least 5 minutes.
- `RoleDemote`: `apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_planner.ex` (`lock_publication_reservations`, the exercised-source check) and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/role_transition_planner.ex`.
- `Claim`: `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex` (`claim_operations_where`: the 60-second lease, the attempt count capped at 100, and the three reservation blocks for a source stop, `remove_participant` and end operations).
- `NodeCalls`, `NodeHears`, `NodePending`: `apps/sync/lib/chalk_sync/external_operation_consumer.ex` (`dispatch_with_context`, `execute_operation`, `@max_attempts`).
- `NodeFinalizes`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`finalize_transaction`) and `apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_settlement.ex` (`settle_child`, the parent status).

Each Postgres action is one transaction under the Episode control row lock. `Claim` locks only the operation row. `tools/formal/external-operations/anchors` lists the exact code fragments each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/external-operations/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh`) once into `~/.cache/chalk-tla`. It takes about 2 minutes on the Mac mini (the two-node role-transition run has 785,000 states). Run it on the Mac mini or Instabox, not the Air. It does four things and fails if any fails:

1. It checks that every fragment in `anchors` is still in its file.
2. It runs TLC on the real code, one operation at a time on two nodes (`rem`, `end`, `rt`), and needs the rules the code keeps to hold. It checks `OperationsSettle` for each operation on one node with no crashes.
3. It runs the real code on one node with every rule, and again without the SFU's revision ordering (the Cloudflare path). Only the claim checks protect a provider that applies controls in arrival order.
4. It runs each broken variant in `breaks` and needs TLC to report the named rule as broken. This proves the check can still fail.

`MaxAttempts = 2` stands for the 100 attempts of the code. `tools/formal/external-operations/run.sh --deep` uses 3 attempts and 5 control revisions. The full TLC logs go to the folder that the last line prints. CI runs `tools/formal/external-operations/run.sh` in `.github/workflows/formal-external-operations.yml` when a covered file or this model changes.

## Read a failure

Read every TLC result with the `/statechart` skill. Give it `tools/formal/external-operations/ExternalOperations.chart.cfg` (set its `Break` to the variant you want to read) and `tools/formal/external-operations/ExternalOperations.view.mjs` so that states and steps use the words of a person in the call. Use the chart config as it is: its view is not a bisimulation of the model, so do not add a `VIEW` to the cfg.

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `ExternalOperations.tla` (see below).

**A rule breaks on the real code.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug: each step is one transaction, so a replay is a Postgres-backed test like the ones in `apps/sync/test/chalk_sync/external_operations_findings_test.exs`.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Compare the action with its code and with the `breaks` line before you change anything. The two claim variants run with `Ordered = FALSE`, because the Chalk SFU refuses a stale control by revision and hides them.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `ExternalOperations.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard (and a `Break` value in the model), and the rule it protects.
4. Run `tools/formal/external-operations/run.sh`. Every rule the code keeps must hold and every variant must break.
5. Move the sync commit in this file to the commit you checked, and update the coverage record and the `git diff` command.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- One participant, one source (the microphone), one Episode. Camera and screen share, several participants and publication fences from other sources are not modeled.
- One operation kind per run (`rt`, `rem` or `end`). The three together are more than TLC can enumerate. Interactions between a remove and an end in the same Episode are not checked.
- The role-transition parent and its cleanup are one status. Settlement of the parent from several children is not modeled.
- The 100 attempts are 2 (3 with `--deep`), and control revisions stop at 4 (5), with at most 2 role changes. A bug that needs more than that is not found.
- Time is a set of flags that expire when the model says so: the 30-second request, the 5-minute fence and the 60-second claim lease. Clock skew and exact durations are not modeled.
- Provider answers: the SFU grants, refuses (when `GrantRefusals` is on) or does not answer. Other error classes collapse into those.
- Liveness (`OperationsSettle`) runs on one node with no crashes, because a node that stops forever settles nothing. Crashes are covered by the safety runs on two nodes.
- The finalizer's other effects (webhooks, attendance, the roster) are not modeled, only the status of the operation.
- The regression tests cover the three fixed bugs only. The other rules are checked against the model of the code, and the `anchors` tie the model to it.
