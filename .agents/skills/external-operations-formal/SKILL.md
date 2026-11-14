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

The real code breaks three of these rules. Each is a finding, kept in `tools/formal/external-operations/findings` and replayed against real Sync code and Postgres in `tools/formal/external-operations/replay/external_operations_findings_test.exs`.

- **F-A, `DemotedPublishesOnlyWhileCleanupRuns`.** A speaker who is publishing asks for a second grant. While that request is open a host takes publishAudio away, which starts a source-stop child. The SFU refuses the second grant. `complete_publication_grant` sees a failed grant that needs cleanup and settles the pending child as applied without calling the SFU. The first grant is still live and nothing will revoke it.
- **F-B, `GivingUpLeavesNothingLive`.** A host takes publishAudio away from a speaker who is publishing. The SFU gives no clear answer to the source stop for 100 attempts, so Sync fails the child with `retry_exhausted`. The role change stays committed, the child is failed and the SFU still holds the source.
- **F-C, `DemotedPublishesOnlyWhileCleanupRuns`.** The Live Episode process reserves a grant and stops before it calls the SFU. The reservation expires. A host takes publishAudio away, and Sync sees an expired reservation and no live source, so it starts no cleanup. The restarted process asks again with the same operation id, gets the expired row back, and the SFU grants the source. The speaker publishes without publishAudio and `complete_publication_grant` only reports `cleanup_required`.

Run the replays with `tools/formal/external-operations/replay/run.sh` (Elixir and Docker; on the Air use `box run -- 'bash scripts/gates/instabox-run.sh tools/formal/external-operations/replay/run.sh'`). Each test passes while its finding is present and fails with "F-x is fixed" when a fix lands. When that happens, remove the row from `findings`, switch its cause off in the model, and delete the test.

The model takes each finding's cause as a constant: `GrantRefusals` (F-A), `GiveUp` (F-B), `ResendsExpired` (F-C). `tools/formal/external-operations/run.sh` requires each finding to keep failing with only its cause on, and requires all rules to hold with the three causes off (the idealized settings).

## Does my change touch the model?

Run this, with the sync commit from the coverage record below:

```sh
git diff --stat 941d5710deeddb444ef904519bf2a792f608fd36 -- apps/sync/lib/chalk_sync/external_operation_consumer.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_settlement.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/role_transition_planner.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Sync commit: `941d5710deeddb444ef904519bf2a792f608fd36`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches.

- `Reserve`: `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex` (`reserve_transaction`, `validate_capability`) and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex` (the reservation insert with a 30-second expiry and the on-conflict overwrite that applies only to an expired row).
- `ResendGrant`: `reserve_transaction` in `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex` returns the existing row for a known operation id, whatever its status.
- `CompleteGrant`: `complete_transaction` and `satisfy_failed_grant_child` in `apps/sync/lib/chalk_sync/stateholder/postgres/publication_grants.ex`, and the completion update in `apps/sync/lib/chalk_sync/stateholder/postgres/sql/publication_grants.ex` that extends the reservation to at least 5 minutes.
- `RoleDemote`: `apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_planner.ex` (`lock_publication_reservations`, the exercised-source check) and `apps/sync/lib/chalk_sync/stateholder/postgres/sql/role_transition_planner.ex`.
- `Claim`: `apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_claims.ex` (`claim_operations_where`: the 60-second lease, the attempt count capped at 100, and the three reservation blocks for a source stop, `remove_participant` and end operations).
- `NodeCalls`, `NodeHears`, `NodePending`: `apps/sync/lib/chalk_sync/external_operation_consumer.ex` (`dispatch_with_context`, `execute_operation`, `@max_attempts`).
- `NodeFinalizes`: `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex` (`finalize_transaction`) and `apps/sync/lib/chalk_sync/stateholder/postgres/role_transition_settlement.ex` (`settle_child`, the parent status).

Each Postgres action is one transaction under the Episode control row lock. `Claim` locks only the operation row. `tools/formal/external-operations/anchors` lists the exact code fragments each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/external-operations/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh`) once into `~/.cache/chalk-tla`. It takes about 2 minutes on the Mac mini (the two-node role-transition run has 785,000 states). Run it on the Mac mini or Instabox, not the Air. It does six things and fails if any fails:

1. It checks that every fragment in `anchors` is still in its file.
2. It runs TLC on the real code, one operation at a time on two nodes (`rem`, `end`, `rt`), and needs the rules the code keeps to hold. It checks `OperationsSettle` for each operation on one node with no crashes.
3. It runs each finding in `findings` with only its cause on and needs TLC to report the rule as broken.
4. It runs the idealized settings (no finding's cause) and needs every rule to hold.
5. It runs the idealized settings without the SFU's revision ordering (the Cloudflare path) and needs every rule to hold. Only the claim checks protect a provider that applies controls in arrival order.
6. It runs each broken variant in `breaks` and needs TLC to report the named rule as broken. This proves the check can still fail.

`MaxAttempts = 2` stands for the 100 attempts of the code. `tools/formal/external-operations/run.sh --deep` uses 3 attempts and 5 control revisions. The full TLC logs go to the folder that the last line prints. CI runs `tools/formal/external-operations/run.sh` in `.github/workflows/formal-external-operations.yml` when a covered file or this model changes.

## Read a failure

Read every TLC result with the `/statechart` skill. Give it `tools/formal/external-operations/ExternalOperations.chart.cfg` and `tools/formal/external-operations/ExternalOperations.view.mjs` so that states and steps use the words of a person in the call. Use the chart config as it is: its view is not a bisimulation of the model, so do not add a `VIEW` to the cfg. `tools/formal/external-operations/chart/chart.svg` shows the two shortest bug paths, F-C and F-B.

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `ExternalOperations.tla` (see below).

**A rule breaks on the real code or a finding stops failing.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug: each step is one transaction, so a replay is a Postgres-backed test like `tools/formal/external-operations/replay/external_operations_findings_test.exs`. If a finding stops failing, someone fixed it: remove its row and its replay as described above.

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
- The replay covers the three findings only. The other rules are checked against the model of the code, and the `anchors` tie the model to it.
