---
name: recording-pipeline-formal
description: 'Model-check the recording pipeline across Sync and the API with TLA+. Use when a change touches the capture job lease or claim, segment writes, stop handling, recovery or reservation expiry in recording_pipeline.sql or recording_key_object_authority.sql, the Sync recording start, stop or Episode end path (recording.ex, external_operation_consumer.ex, external_operation_planner.ex, external_operation_finalizer.ex, episodes/reducer.ex), the SFU executor, when CI''s "Recording pipeline model" check fails, or to prove a recording ordering bug.'
---

# Recording pipeline model

A Chalk recording lives in two services that share one Postgres. Sync owns the `sync_recordings` row and the Episode that ends it. The API owns the `recording_pipelines` row, the capture job lease, the capture nodes that claim that lease, and the segments they write. A host presses Record, a node leases the job, captures segments and completes, and a stop or the Episode end can arrive at any point, including while a node crashes, its lease expires, or a second node claims the job. Tests reach these orderings only by luck, because each one needs several transactions from different services to land in one specific order.

`tools/formal/recording-pipeline/RecordingPipeline.tla` models one recording and checks these rules in every order the steps can happen in:

| Rule                                   | Plain sentence                                                                                                                         | Harm when it breaks                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OnlyLeaseHolderWrites`                | A segment is written only by the node that holds the live lease for the capture.                                                       | A node that lost its lease keeps writing, so two nodes write one recording and the render mixes segments from a capture that no longer owns the job. |
| `NoLeaseSteal`                         | A claim never replaces a live lease, so two nodes never hold one capture lease.                                                        | Two nodes capture the same call and both bill and write, and the first node's work is thrown away or corrupted.                                      |
| `NoFreshCaptureAfterStop`              | Once a stop was requested, a claim starts only a completion-only attempt, never a fresh capture.                                       | A recording that the host stopped starts capturing again and records the call after the stop.                                                        |
| `SegmentsFrozenAtCompletion`           | The segments are frozen when the capture succeeds, so rendering and committing see the same set.                                       | The render and the committed artifact disagree about which segments the recording has.                                                               |
| `LostTailIsSalvaged`                   | A recording that lost its final segment is always marked salvaged.                                                                     | A recording with a missing end looks complete, and nobody knows to tell the host.                                                                    |
| `EndedEpisodeHasNoUnstoppedCapture`    | After Sync ended the Episode, no capture runs without a stop request.                                                                  | A capture node keeps recording and keeps its slot after the call is over.                                                                            |
| `SyncRecordingHasPipeline`             | Sync shows a recording as recording or stopping only while the API has its pipeline.                                                   | The host sees a recording that nothing can stop or finish.                                                                                           |
| `FinalStatesStay`                      | A committed or terminal pipeline never changes.                                                                                        | A finished recording is reopened, or a failed one comes back to life.                                                                                |
| `EndedEpisodeResolves`                 | Once Sync ended the Episode, the API recording always reaches capture complete or a terminal state, while time passes and nodes retry. | A recording of an ended call stays in the pipeline forever and keeps a capture slot.                                                                 |
| `EndedEpisodeLeavesNoRunningRecording` | Once Sync ended the Episode, its recording row is no longer starting, recording or stopping.                                           | The roster of an ended call still shows a recording.                                                                                                 |

All ten rules hold on the real code at the bounds below. The model found no recording bug.

## What the code does not promise

Read this before you "fix" a rule. These behaviors are real, and the model records them as they are.

- Before the Episode ends, nothing guarantees that a started recording leaves "starting" or "recording". A capture job that failed after its reservation ended is never claimed again (the claim needs a live reservation, or a completion-only attempt that only a stop opens) and is never expired (`ExpireRecordingReservations` needs attempt count 0 and a `reserved` pipeline). The pipeline stays `retryable_failure` and Sync's row stays "recording" until the Episode ends, which is why `EndedEpisodeLeavesNoRunningRecording` starts at the Episode end and not before. The Episode deadline bounds it.
- `deleted` is unreachable in production: no caller of `Service.ReleaseReservation` exists, so the model has no `deleted` state.

## Does my change touch the model?

Run this, with the commit from the coverage record below:

```sh
git diff --stat 941d5710deeddb444ef904519bf2a792f608fd36 -- apps/api/db/queries/recording_pipeline.sql apps/api/db/queries/recording_key_object_authority.sql apps/api/db/queries/recording_capture_lifecycle.sql apps/api/internal/recordingpipeline apps/api/internal/capturesignaling apps/api/internal/recorderfleet apps/api/internal/recorderworker apps/api/internal/recordingorchestrator apps/api/internal/providerbridge/sfu_executor.go apps/sync/lib/chalk_sync/episodes/reducer.ex apps/sync/lib/chalk_sync/external_operation_consumer.ex apps/sync/lib/chalk_sync/stateholder/postgres/recording.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_finalizer.ex apps/sync/lib/chalk_sync/stateholder/postgres/sql/external_operation_planner.ex
```

If the diff touches a function in the coverage record, read it against the model action that names that function. A change outside those functions, such as render or artifact code in the same file, needs no model work. Run the check anyway, because it is cheap.

## Coverage record

Commit: `941d5710deeddb444ef904519bf2a792f608fd36`. At this commit the model was confirmed to describe the functions below. Move it forward only after you have read the covered functions at the new commit and confirmed that every model action still matches them.

- `AcceptStart`, `DispatchStart`: `prepare_recording` for `:start_recording` in `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_planner.ex`, then `dispatch` in `apps/sync/lib/chalk_sync/external_operation_consumer.ex`, which calls `recordingorchestrator` `Controller.Start` and the `CreateRecordingReservation` query.
- `CaptureReadyFact`, `CaptureFailedFact`: `recording_capture_ready` and `recording_capture_failed` in `apps/sync/lib/chalk_sync/stateholder/postgres/external_operation_finalizer.ex`, and `capture_source_pending?` in `apps/sync/lib/chalk_sync/stateholder/postgres/recording.ex`.
- `AcceptManualStop`, `DispatchManualStop`: `prepare_recording` for `:stop_recording` and `accept_recording_stop` in the planner SQL, then the `RequestRecordingStop` query. `stop_operation_id` keeps the first stop.
- `AcceptEnd`, `DispatchEndStop`, `FinalizeEnd`: `prepare_end_operation` and `lock_active_recording_for_end` (planner), `invoke_end_cleanup` and `end_recording_call` in `apps/sync/lib/chalk_sync/external_operation_consumer.ex` with `recordingExecutionFailure` in `apps/api/internal/providerbridge/sfu_executor.go`, and `finalize_confirmed_operation` and `complete_external_episode_recordings` in the finalizer.
- `PublishCaptureStopped`, `ApplyCaptureStopped`, `ApplyDeadlineStop`: the capture-stopped publication in the recording lifecycle (`recording_publish_completed_capture_stop`, `deadlineStop`), and `validate_capture_stopped` and `prepare_capture_stopped` in `apps/sync/lib/chalk_sync/stateholder/postgres/recording.ex` with the Episode reducer.
- `Claim`: the `ClaimRecordingJob` query in `apps/api/db/queries/recording_pipeline.sql`. Every guard in `ClaimGuard` is an anchor.
- `NodeReady`, `NodeAllocate`, `NodeCommit`: `SetRecordingCaptureReadyAt`, `ReserveRecordingBundleAllocation`, `InsertRecordingBundleAllocation`, `CommitRecordingBundleAllocation` and `InsertRecordingBundle` (`apps/api/db/queries/recording_key_object_authority.sql` and `apps/api/db/queries/recording_pipeline.sql`).
- `NodeComplete`, `NodeFail`, `NodeRelinquish`: `CompleteCaptureRecordingJob`, `FailRecordingJob`, `RelinquishCaptureRecordingJob`.
- `LeaseExpires`, `Recover`, `ExpireReservation`: the clock, `RecoverExpiredRecordingJobs` (both clauses) and `ExpireRecordingReservations`.
- `RenderStart`, `RenderCommit`, `RenderFails`: `RequestDeferredRecordingRender`, the render claim and `CommitRecordingArtifact`.
- `ReservationEnds`, `SalvageDeadlinePasses`: time.

Each action is one Postgres transaction that reads and writes both services' rows, because Sync and the API share one database and the API's SQL reads `sync_recordings` and `sync_external_operations`. If a change splits one of these transactions, or lets a service decide from a stale read across two transactions, the model's atomic step is wrong and must be split too.

`tools/formal/recording-pipeline/anchors` lists the exact code fragments that each action mirrors. The check fails when one is gone, so a change to a guard always comes back here.

## Run the check

```sh
tools/formal/recording-pipeline/run.sh
```

It needs Java 11 or later and curl, and it downloads the pinned TLA+ tools (v1.7.4, pinned by checksum in `tools/formal/tla2tools.sh` for every model) once into `~/.cache/chalk-tla`. It takes a few minutes. It does three things, and fails if any one fails:

1. It checks that every fragment in `anchors` is still in its file. `run.sh --anchors` runs only this, in a second.
2. It runs TLC on `RecordingPipeline.cfg` (2 capture nodes, an attempt limit of 2, 2 segments, `Break = "none"`), which is the real code, and needs every rule to hold. That is about 1.35 million states generated and 340 thousand distinct states.
3. It runs each broken variant in `breaks` on one worker, checking only the rule that variant is listed for, and needs TLC to report that rule as broken. This proves the check can still fail.

`run.sh --tlc` skips the anchors. Set `FORMAL_OUT` to keep the TLC logs in a folder you choose; the last line prints the folder.

CI runs `tools/formal/recording-pipeline/run.sh` in `.github/workflows/formal-recording-pipeline.yml` when a covered file or this model changes.

Real code breaks, shown once: each variant in `breaks` mirrors an edit of the SQL. The Go tests in `apps/api/internal/adapters/postgres/recording_pipeline_formal_integration_test.go` run on a real Postgres and fail on these edits of `apps/api/internal/adapters/postgres/sqlc/recording_pipeline.sql.go`:

- `write_ignores_expiry`: dropping `lease_expires_at > now()` from `insertRecordingBundle` fails `TestRecordingBundleWriteNeedsLiveLeaseOfRunningCapture`.
- `claim_ignores_job_state`: the claim has two guards for this, `recording_jobs.state = 'pending'` and the pipeline state in `reserved` or `retryable_failure` (in both the `candidate` and the `pipeline` step). Dropping one alone changes nothing a test can see. Dropping all three makes a second worker take a live lease, and `TestRecordingClaimDoesNotStealLiveLease` fails.
- `claim_ignores_stop`: the claim has four stop guards (two on `stop_requested_at`, one on `stop_operation_id`, and the `pipeline` step's `stop_operation_id is null`). Dropping them all starts a fresh capture after a stop, and `TestRecordingClaimStartsNoFreshCaptureAfterStop` fails. Any one guard is enough, so the model treats them as one guard.
- `segment_after_complete`: no real-code edit shows it. `recording_jobs_check1` forbids a lease on a succeeded job, so `lease_token` already refuses a late segment and `state = 'leased'` is a second guard on the same case. The model keeps the variant for the case where someone removes the constraint and this clause together.
- The other four variants (`write_ignores_fence`, `salvage_not_flagged`, `recover_skips_stopped`, `end_skips_recording_stop`) were not replayed against scratch breaks of the real code.

## Read a failure

Read every TLC result with the `/statechart` skill, and give it `tools/formal/recording-pipeline/RecordingPipeline.view.mjs` as the view so that states and steps use the words of a host who records a call. The real model has about 340 thousand states, which is over the chart budget, so `/statechart` draws a chart only for a rule that breaks. To see one, set `Break` in a copy of the cfg to a variant from `breaks` and use a small bound (`Nodes = {n1}`, `TryLimit = 1`, `MaxSegments = 1`).

**An anchor fails.** Someone changed code that a model action mirrors. Read the diff against that action. If the guard only moved or was reformatted with the same meaning, update the fragment in `anchors`. If the meaning changed, change the action in `RecordingPipeline.tla` to match the new code, then run again. Never edit a fragment just to make it match without reading the code.

**A rule breaks on `Break = "none"`.** Tell the path as `/statechart` gives it, then replay it against the real code before you call it a bug. Each step maps to one transaction, so a replay is a throwaway Postgres-backed Go test that drives those queries in that order. If the replay shows the bug, report it with the path in Chalk's words and leave the rule as it is. If the replay does not show it, the model is wrong: find the step whose guard differs from the code and fix the step. When a `PROPERTY` breaks with a path that ends in a state that repeats forever, ask first whether the code bounds that state some other way, such as the Episode deadline, before you call it a bug. `EndedEpisodeLeavesNoRunningRecording` exists because two earlier rules, "a started recording always leaves starting" and "a stopped one always leaves stopping", broke only for that reason.

**A broken variant no longer breaks its rule.** The model drifted so that the guard that variant removes no longer matters. Usually an action lost a condition it should have. Compare the action with its code and with the `breaks` line before you change anything. Do not delete the variant.

## Change the model on purpose

When a change to the covered code is intended:

1. Change the matching action in `RecordingPipeline.tla` so that it says what the new code does, with the function names in its comment.
2. Update `anchors` to the new fragments.
3. If the change removes or adds a guard, add a line to `breaks` with a variant that removes the guard (add its name to `BreakNames` and use it in the action), and the rule it protects.
4. Run `tools/formal/recording-pipeline/run.sh`. All rules must hold on the real code and every variant must break.
5. Move the commit in this file to the commit you checked, and update the coverage record and the paths in `git diff` above.

Never weaken a rule or drop a variant to make the check pass. A rule that fails on the real code is a finding.

## What the model leaves out

- One recording in one Episode, and one capture job with its pipeline. Several recordings per Episode, retries of a start with a new key, and the reservation capacity limit (`LockRecordingCapacity`) are not modeled.
- Rendering is three steps (start, commit, fail). The decode, key and object-storage work, deferred artifacts and the data key are left out.
- Segments are a count up to `MaxSegments`. Their contents, bundle tokens and the allocation hash fences are not modeled.
- Time is a few events: a lease expires, the reservation ends, the salvage deadline passes. There are no durations, no heartbeats (a heartbeat only extends a live lease, so it changes nothing here) and no clock skew between the nodes and the database.
- The Sync side is the recording row and the start, stop and end operations. The Episode reducer's other states, the live-roster fanout and the webhook are left out.
- `deleted` and `cancelled` pipeline states are not modeled, because no production path reaches them.
- Bounds: 2 capture nodes, an attempt limit of 2 and at most 2 segments on every run. A third node and a larger attempt limit are not checked.
