------------------------- MODULE RecordingPipeline -------------------------
(***************************************************************************)
(* One Chalk Recording across Sync and the API: the Sync Episode and       *)
(* `sync_recordings` row, the API `recording_pipelines` row, its capture   *)
(* job lease, the capture nodes, and the segments they write.              *)
(*                                                                         *)
(* Sync and the API share one Postgres, so each action is one transaction  *)
(* that reads and writes both sides (the API's SQL reads `sync_recordings` *)
(* and `sync_external_operations`). Paths are under apps/sync/lib/         *)
(* chalk_sync/ and apps/api/ (see README.md for the full action table).    *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Nodes,       \* capture nodes (recorder workers) that can claim the capture job
    TryLimit,    \* recording_jobs.attempt_limit
    MaxSegments, \* segments a capture may commit
    Break        \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "write_ignores_fence",      \* InsertRecordingBundle/CommitRecordingBundleAllocation drop lease_token, owner and fencing_generation
    "write_ignores_expiry",     \* the same writes drop `lease_expires_at > now()`
    "claim_ignores_job_state",  \* ClaimRecordingJob drops `recording_jobs.state = 'pending'`
    "claim_ignores_stop",       \* ClaimRecordingJob drops the stop_operation_id guards
    "segment_after_complete",   \* InsertRecordingBundle drops `state = 'leased'`
    "recover_skips_stopped",    \* RecoverExpiredRecordingJobs drops the pending-after-stop clause
    "end_skips_recording_stop", \* end_episode finalizes without the API stop (invoke_end_cleanup skips the recording call)
    "salvage_not_flagged"       \* CompleteCaptureRecordingJob drops the recording.capture.salvaged event
}

ASSUME Nodes # {} /\ TryLimit \in 1..4 /\ MaxSegments \in 1..2
ASSUME Break \in BreakNames

VARIABLES
    ep,           \* episodes.status: "active", "ending" or "ended"
    rec,          \* sync_recordings.status, "none" before the row exists
    startOp,      \* the start_recording operation: "none", "pending", "applied" or "failed"
    syncStop,     \* sync_recordings.stop_external_operation_id: "none", "manual" or "episode"
    stopOp,       \* the manual stop_recording operation: "none", "pending" or "applied"
    endOp,        \* the end_episode operation: "none", "pending", "applied" or "failed"
    endHasRec,    \* the end operation carries recording_id (lock_active_recording_for_end found a row)
    endStopDone,  \* the end operation's stop_recording call to the API returned confirmed
    capStopOp,    \* the recording_capture_stopped operation: "none", "pending" or "applied"
    pipe,         \* recording_pipelines.state, "none" before the reservation exists
    job,          \* the capture recording_jobs.state
    pipeStop,     \* recording_pipelines.stop_operation_id: "none", "manual" or "episode"
    ready,        \* recording_pipelines.capture_ready_at is not null
    gen,          \* recording_jobs.fencing_generation
    tries,        \* recording_jobs.attempt_count
    compTries,    \* recording_capture_completion_attempts: completion_only attempts so far
    holder,       \* recording_jobs.lease_owner, "none" when nobody holds the lease
    leaseLive,    \* recording_jobs.lease_expires_at > clock_timestamp()
    compOnly,     \* the current attempt's envelope says completion_only
    alloc,        \* a recording_bundle_allocations row is allocated and not yet committed
    committed,    \* committed recording_bundle_allocations rows
    closedSegs,   \* committed rows at the moment the capture job succeeded, 0 before that
    lostTail,     \* the capture succeeded while a segment was still only allocated
    salvaged,     \* the recording.capture.salvaged event was written
    resEnded,     \* recording_reservations.ends_at <= now()
    salvageOver,  \* recording_capture_salvage_deadline(recording_id) <= clock_timestamp()
    nodeGen,      \* the fencing generation each node was handed by its last claim
    bad           \* accepted steps the rules forbid: "stale" write, "stolen" lease, "fresh" capture after a stop

vars == <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp,
          pipe, job, pipeStop, ready, gen, tries, compTries, holder, leaseLive, compOnly,
          alloc, committed, closedSegs, lostTail, salvaged, resEnded, salvageOver,
          nodeGen, bad>>

MaxGen == TryLimit + 3
Gens == 0..MaxGen

TypeOK ==
    /\ ep \in {"active", "ending", "ended"}
    /\ rec \in {"none", "starting", "recording", "stopping", "stopped", "failed"}
    /\ startOp \in {"none", "pending", "applied", "failed"}
    /\ syncStop \in {"none", "manual", "episode"}
    /\ stopOp \in {"none", "pending", "applied"}
    /\ endOp \in {"none", "pending", "applied", "failed"}
    /\ endHasRec \in BOOLEAN /\ endStopDone \in BOOLEAN
    /\ capStopOp \in {"none", "pending", "applied"}
    /\ pipe \in {"none", "reserved", "leased", "capturing", "retryable", "complete",
                 "rendering", "committed", "terminal"}
    /\ job \in {"none", "pending", "leased", "succeeded", "terminal"}
    /\ pipeStop \in {"none", "manual", "episode"}
    /\ ready \in BOOLEAN
    /\ gen \in Gens /\ tries \in 0..TryLimit /\ compTries \in 0..3
    /\ holder \in Nodes \cup {"none"}
    /\ leaseLive \in BOOLEAN /\ compOnly \in BOOLEAN /\ alloc \in BOOLEAN
    /\ committed \in 0..MaxSegments /\ closedSegs \in 0..MaxSegments
    /\ lostTail \in BOOLEAN /\ salvaged \in BOOLEAN
    /\ resEnded \in BOOLEAN /\ salvageOver \in BOOLEAN
    /\ nodeGen \in [Nodes -> Gens]
    /\ bad \subseteq {"stale", "stolen", "fresh"}

Init ==
    /\ ep = "active" /\ rec = "none" /\ startOp = "none" /\ syncStop = "none"
    /\ stopOp = "none" /\ endOp = "none" /\ endHasRec = FALSE /\ endStopDone = FALSE
    /\ capStopOp = "none"
    /\ pipe = "none" /\ job = "none" /\ pipeStop = "none" /\ ready = FALSE
    /\ gen = 0 /\ tries = 0 /\ compTries = 0 /\ holder = "none"
    /\ leaseLive = FALSE /\ compOnly = FALSE /\ alloc = FALSE
    /\ committed = 0 /\ closedSegs = 0 /\ lostTail = FALSE /\ salvaged = FALSE
    /\ resEnded = FALSE /\ salvageOver = FALSE
    /\ nodeGen = [n \in Nodes |-> 0]
    /\ bad = {}

(***************************************************************************)
(* Derived facts, each a SQL function or expression                         *)
(***************************************************************************)

\* recording_capture_stop_confirmed: Sync stopped the recording and applied the capture-stopped fact.
StopConfirmed == rec = "stopped" /\ capStopOp = "applied"

\* recording_capture_completion_available: a stop was requested after capture was ready, and either
\* the stop is confirmed or the salvage window is open with a committed bundle.
CompletionAvailable ==
    /\ pipeStop # "none"
    /\ ready
    /\ (StopConfirmed \/ (~salvageOver /\ committed > 0))

\* A completion-only attempt is allowed while fewer than three have run.
CompletionOpen == CompletionAvailable /\ compTries < 3

\* The lease the database accepts for a write by node n: state, owner, token and generation match
\* and the lease has not expired (the guards of InsertRecordingBundle and CommitRecordingBundleAllocation).
Holds(n) == job = "leased" /\ holder = n /\ nodeGen[n] = gen /\ leaseLive

\* What a write by node n needs under the selected variant.
CanWrite(n) ==
    CASE Break = "write_ignores_fence"  -> job = "leased" /\ leaseLive /\ nodeGen[n] > 0
      [] Break = "write_ignores_expiry" -> job = "leased" /\ holder = n /\ nodeGen[n] = gen
      [] OTHER -> Holds(n)

\* A job state that ends in "terminal" for the next pipeline state.
PipeAfter(j) == IF j = "terminal" THEN "terminal" ELSE "retryable"

(***************************************************************************)
(* Sync actions                                                             *)
(***************************************************************************)

\* external_operation_planner.ex prepare_recording (:start_recording) + SQL.insert_recording_reservation.
AcceptStart ==
    /\ ep = "active" /\ rec = "none"
    /\ rec' = "starting" /\ startOp' = "pending"
    /\ UNCHANGED <<ep, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* external_operation_consumer.ex dispatch (:start_recording) -> recordingorchestrator Controller.Start ->
\* CreateRecordingReservation. The SQL checks that the episode exists, not that it is active.
DispatchStart ==
    /\ startOp = "pending"
    /\ pipe = "none"
    /\ pipe' = "reserved" /\ job' = "pending"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* Sync applies the recording_capture_ready fact once the API recorded capture_ready_at:
\* external_operation_finalizer.ex (recording_capture_ready), recording.ex capture_source_pending?.
CaptureReadyFact ==
    /\ ep = "active" /\ rec = "starting" /\ syncStop = "none" /\ startOp = "pending"
    /\ ready /\ pipe \in {"capturing", "leased", "retryable", "complete", "rendering", "committed"}
    /\ rec' = "recording" /\ startOp' = "applied"
    /\ UNCHANGED <<ep, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* recording_capture_failed: the API gave up (terminal pipeline) while Sync still shows the recording
\* as starting, recording or stopping. Sync finalizes it only while the Episode is active.
CaptureFailedFact ==
    /\ ep = "active" /\ pipe = "terminal"
    /\ rec \in {"starting", "recording", "stopping"}
    /\ rec' = "failed"
    /\ startOp' = IF startOp = "pending" THEN "failed" ELSE startOp
    /\ UNCHANGED <<ep, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* external_operation_planner.ex prepare_recording (:stop_recording) + SQL.accept_recording_stop.
AcceptManualStop ==
    /\ ep = "active" /\ rec = "recording" /\ syncStop = "none"
    /\ rec' = "stopping" /\ syncStop' = "manual" /\ stopOp' = "pending"
    /\ UNCHANGED <<ep, startOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* Controller.Stop -> RequestRecordingStop. stop_operation_id keeps the first stop; the SQL accepts a
\* manual stop only for its own operation and an end operation while it is pending.
DispatchManualStop ==
    /\ stopOp = "pending" /\ pipe # "none"
    /\ pipeStop' = IF pipeStop = "none" THEN "manual" ELSE pipeStop
    /\ stopOp' = "applied"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, endOp, endHasRec, endStopDone, capStopOp, pipe, job,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* external_operation_planner.ex prepare_end_operation: the end carries the recording that
\* SQL.lock_active_recording_for_end finds in starting, recording or stopping.
AcceptEnd ==
    /\ ep = "active" /\ endOp = "none"
    /\ ep' = "ending" /\ endOp' = "pending"
    /\ endHasRec' = (rec \in {"starting", "recording", "stopping"})
    /\ UNCHANGED <<rec, startOp, syncStop, stopOp, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* external_operation_consumer.ex invoke_end_cleanup -> end_recording_call -> RequestRecordingStop.
\* A missing pipeline is ErrPipelineNotFound, which sfu_executor.go recordingExecutionFailure maps to a
\* terminal failure, so the end fails (release_failed_acceptance puts the Episode back to active).
DispatchEndStop ==
    /\ endOp = "pending" /\ ep = "ending" /\ endHasRec /\ ~endStopDone
    /\ IF pipe = "none"
         THEN /\ endOp' = "failed" /\ ep' = "active" /\ endHasRec' = FALSE
              /\ UNCHANGED <<endStopDone, pipeStop>>
         ELSE /\ endStopDone' = TRUE
              /\ pipeStop' = IF pipeStop = "none" THEN "episode" ELSE pipeStop
              /\ UNCHANGED <<endOp, ep, endHasRec>>
    /\ UNCHANGED <<rec, startOp, syncStop, stopOp, capStopOp, pipe, job,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* external_operation_finalizer.ex finalize_confirmed_operation for end_episode:
\* complete_external_episode_recordings marks the Sync recording stopped without waiting for the API.
FinalizeEnd ==
    /\ endOp = "pending" /\ ep = "ending"
    /\ (~endHasRec \/ endStopDone \/ Break = "end_skips_recording_stop")
    /\ ep' = "ended" /\ endOp' = "applied"
    /\ rec' = IF rec \in {"starting", "recording", "stopping"} THEN "stopped" ELSE rec
    /\ UNCHANGED <<startOp, syncStop, stopOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* recording_publish_completed_capture_stop / recording_try_publish_capture_stop: after capture
\* completed for a manual stop that Sync still shows as stopping, the API inserts the operation.
PublishCaptureStopped ==
    /\ capStopOp = "none" /\ job = "succeeded"
    /\ pipeStop = "manual" /\ syncStop = "manual" /\ rec = "stopping"
    /\ stopOp = "applied"
    /\ capStopOp' = "pending"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* The capture reached its reservation deadline without a stop request: the worker publishes
\* recording_capture_stopped with the deadline payload (recording_lifecycle.go deadlineStop) and Sync
\* stops the recording (recording.ex validate_capture_stopped, deadline clause).
ApplyDeadlineStop ==
    /\ job = "succeeded" /\ pipeStop = "none" /\ resEnded
    /\ rec \in {"starting", "recording", "stopping"}
    /\ rec' = "stopped"
    /\ UNCHANGED <<ep, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* recording.ex prepare_capture_stopped + finalizer: Sync marks the recording stopped.
ApplyCaptureStopped ==
    /\ capStopOp = "pending" /\ rec \in {"stopping", "stopped"}
    /\ rec' = "stopped" /\ capStopOp' = "applied"
    /\ UNCHANGED <<ep, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

(***************************************************************************)
(* API actions                                                              *)
(***************************************************************************)

\* ClaimRecordingJob (recording_pipeline.sql): candidate guards and the lease update.
ClaimGuard ==
    /\ (Break = "claim_ignores_job_state" \/ job = "pending")
    /\ (pipe \in {"reserved", "retryable"} \/ (Break = "claim_ignores_job_state" /\ pipe # "none"))
    /\ (Break = "claim_ignores_stop" \/ pipeStop = "none" \/ CompletionOpen)
    /\ (~resEnded \/ CompletionOpen)
    /\ (tries < TryLimit \/ CompletionOpen)

Claim(n) ==
    /\ ClaimGuard
    /\ LET co == CompletionAvailable IN
       /\ gen < MaxGen
       /\ job' = "leased" /\ gen' = gen + 1 /\ holder' = n /\ leaseLive' = TRUE
       /\ nodeGen' = [nodeGen EXCEPT ![n] = gen + 1]
       /\ tries' = IF tries < TryLimit THEN tries + 1 ELSE tries
       /\ compOnly' = co
       /\ compTries' = IF co /\ compTries < 3 THEN compTries + 1 ELSE compTries
       \* The pipeline update carries `completion_only or stop_operation_id is null`.
       /\ pipe' = IF pipe \in {"reserved", "retryable"} /\ (co \/ pipeStop = "none") THEN "leased" ELSE pipe
       /\ alloc' = IF co THEN alloc ELSE FALSE
    /\ bad' = bad \cup (IF job = "leased" /\ leaseLive THEN {"stolen"} ELSE {})
                  \cup (IF pipeStop # "none" /\ ~CompletionAvailable THEN {"fresh"} ELSE {})
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, committed, closedSegs, lostTail, salvaged, resEnded, salvageOver>>

\* The lease runs out: time passes, nobody heartbeats (HeartbeatRecordingJob needs a live lease).
LeaseExpires ==
    /\ job = "leased" /\ leaseLive
    /\ leaseLive' = FALSE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* SetRecordingCaptureReadyAt: capture_leased -> capturing_segmented. Only a normal attempt starts capture.
NodeReady(n) ==
    /\ Holds(n) /\ ~compOnly /\ pipe \in {"leased", "capturing"}
    /\ pipe' = "capturing" /\ ready' = TRUE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, job, pipeStop,
                   gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* ReserveRecordingBundleAllocation / InsertRecordingBundleAllocation: an allocated segment.
NodeAllocate(n) ==
    /\ CanWrite(n) /\ ~compOnly /\ ready /\ ~alloc /\ committed < MaxSegments
    /\ alloc' = TRUE
    /\ bad' = bad \cup (IF Holds(n) THEN {} ELSE {"stale"})
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen>>

\* CommitRecordingBundleAllocation / InsertRecordingBundle: the segment becomes committed.
NodeCommit(n) ==
    /\ (CanWrite(n) \/ (Break = "segment_after_complete" /\ job = "succeeded" /\ nodeGen[n] > 0))
    /\ alloc /\ committed < MaxSegments
    /\ alloc' = FALSE /\ committed' = committed + 1
    /\ bad' = bad \cup (IF Holds(n) THEN {} ELSE {"stale"})
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen>>

\* CompleteCaptureRecordingJob: the job succeeds, the pipeline moves on, the reservation is released.
\* A normal holder commits its last segment first. A completion-only holder inherits whatever the
\* crashed attempt left, and the salvage event marks that case.
NodeComplete(n) ==
    /\ Holds(n)
    /\ (compOnly => CompletionAvailable)
    \* A normal holder completes after it started capturing and either saw the stop or reached the deadline.
    /\ (compOnly \/ (ready /\ ~alloc /\ (pipeStop # "none" \/ resEnded)))
    /\ job' = "succeeded" /\ holder' = "none" /\ leaseLive' = FALSE
    /\ pipe' = "complete" /\ closedSegs' = committed
    /\ lostTail' = (lostTail \/ alloc)
    /\ salvaged' = (salvaged \/ (compOnly /\ ~StopConfirmed /\ Break # "salvage_not_flagged"))
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, tries, compTries, compOnly, alloc, committed, resEnded, salvageOver,
                   nodeGen, bad>>

\* FailRecordingJob: a normal failure retries until the attempt limit. After a stop was requested, a
\* completion failure retries until three completion-only attempts have run.
NodeFail(n, completionFailure) ==
    /\ Holds(n)
    /\ (completionFailure => (pipeStop # "none" \/ compOnly))
    /\ LET next == IF completionFailure \/ CompletionAvailable
                       THEN IF compTries >= 3 THEN "terminal" ELSE "pending"
                       ELSE IF tries >= TryLimit THEN "terminal" ELSE "pending"
       IN /\ job' = next /\ pipe' = PipeAfter(next)
    /\ holder' = "none" /\ leaseLive' = FALSE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, tries, compTries, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* RelinquishCaptureRecordingJob: a node hands the job back before any stop was requested.
NodeRelinquish(n) ==
    /\ Holds(n) /\ pipeStop = "none" /\ pipe \in {"leased", "capturing"}
    /\ job' = "pending" /\ pipe' = "retryable" /\ tries' = tries - 1
    /\ holder' = "none" /\ leaseLive' = FALSE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, compTries, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* RecoverExpiredRecordingJobs: expired leases, and (second clause) pending capture jobs whose stop was
\* requested. The job goes terminal when attempts ran out outside completion-only mode, when the salvage
\* deadline passed, or when a stop was requested and no completion attempt is left. The pipeline update
\* has no state guard: it follows the job.
Recover ==
    /\ \/ (job = "leased" /\ ~leaseLive)
       \/ (job = "pending" /\ pipeStop # "none" /\ Break # "recover_skips_stopped")
    /\ LET co == CompletionAvailable
           sourceExpired == ready /\ salvageOver /\ ~StopConfirmed
           dead == (tries >= TryLimit /\ ~co) \/ sourceExpired
                   \/ (pipeStop # "none" /\ (~co \/ compTries >= 3))
           next == IF dead THEN "terminal" ELSE "pending"
       IN /\ job' = next /\ pipe' = PipeAfter(next)
    /\ holder' = "none" /\ leaseLive' = FALSE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, tries, compTries, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* ExpireRecordingReservations: a reservation nobody claimed in time fails.
ExpireReservation ==
    /\ pipe = "reserved" /\ job = "pending" /\ tries = 0 /\ resEnded
    /\ job' = "terminal" /\ pipe' = "terminal"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* Render and commit (RequestDeferredRecordingRender / ClaimRecordingJob render / CommitRecordingArtifact).
RenderStart ==
    /\ pipe = "complete" /\ pipe' = "rendering"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

RenderCommit ==
    /\ pipe = "rendering" /\ pipe' = "committed"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

RenderFails ==
    /\ pipe = "rendering" /\ pipe' = "terminal"
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, salvageOver, nodeGen, bad>>

\* Time passes: the reservation ends, then (once a stop was requested) the salvage deadline.
ReservationEnds ==
    /\ ~resEnded /\ resEnded' = TRUE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, salvageOver, nodeGen, bad>>

SalvageDeadlinePasses ==
    /\ resEnded /\ pipeStop # "none" /\ ~salvageOver /\ salvageOver' = TRUE
    /\ UNCHANGED <<ep, rec, startOp, syncStop, stopOp, endOp, endHasRec, endStopDone, capStopOp, pipe, job, pipeStop,
                   ready, gen, tries, compTries, holder, leaseLive, compOnly, alloc, committed,
                   closedSegs, lostTail, salvaged, resEnded, nodeGen, bad>>

\* Every state with no step out is a correct end state.
Done == UNCHANGED vars

Next ==
    \/ AcceptStart \/ DispatchStart \/ CaptureReadyFact \/ CaptureFailedFact
    \/ AcceptManualStop \/ DispatchManualStop
    \/ AcceptEnd \/ DispatchEndStop \/ FinalizeEnd
    \/ PublishCaptureStopped \/ ApplyCaptureStopped \/ ApplyDeadlineStop
    \/ \E n \in Nodes :
         \/ Claim(n) \/ NodeReady(n) \/ NodeAllocate(n) \/ NodeCommit(n)
         \/ NodeComplete(n) \/ NodeFail(n, FALSE) \/ NodeFail(n, TRUE) \/ NodeRelinquish(n)
    \/ LeaseExpires \/ Recover \/ ExpireReservation
    \/ RenderStart \/ RenderCommit \/ RenderFails
    \/ ReservationEnds \/ SalvageDeadlinePasses
    \/ Done

(***************************************************************************)
(* Rules                                                                    *)
(***************************************************************************)

\* A segment is written only by the node that holds the live lease.
OnlyLeaseHolderWrites == "stale" \notin bad

\* A claim never replaces a live lease, so two nodes never hold one capture lease.
NoLeaseSteal == "stolen" \notin bad

\* Once a stop was requested, a claim only starts a completion-only attempt, never a fresh capture.
NoFreshCaptureAfterStop == "fresh" \notin bad

\* The segments are frozen when the capture succeeds: rendering and committing see the same set.
SegmentsFrozenAtCompletion ==
    (pipe \in {"complete", "rendering", "committed"}) => (job = "succeeded" /\ committed = closedSegs)

\* A recording that lost its final segment is always marked salvaged.
LostTailIsSalvaged == (pipe \in {"complete", "rendering", "committed"} /\ lostTail) => salvaged

\* After Sync ended the Episode, no capture runs without a stop request.
EndedEpisodeHasNoUnstoppedCapture ==
    (ep = "ended" /\ pipe \in {"reserved", "leased", "capturing", "retryable"}) => pipeStop # "none"

\* Sync shows a recording as recording or stopping only while the API has its pipeline.
SyncRecordingHasPipeline == (rec \in {"recording", "stopping"}) => pipe # "none"

\* committed and terminal pipelines never change. (deleted is not modeled: no production code calls
\* Service.ReleaseReservation, the only writer of that state.)
FinalStatesStay ==
    [][ /\ pipe = "committed" => pipe' = "committed"
        /\ pipe = "terminal" => pipe' = "terminal" ]_vars

\* Once Sync ended the Episode, the API recording always reaches capture complete or a terminal state.
EndedEpisodeResolves ==
    (ep = "ended") ~> (pipe \in {"none", "complete", "rendering", "committed", "terminal"})

\* Once Sync ended the Episode, its recording row is no longer starting, recording or stopping.
\* (Before the end nothing promises it: a capture job that failed after the reservation ended is
\* never claimed again and never expired, so the row can stay "recording" until the Episode ends.)
EndedEpisodeLeavesNoRunningRecording ==
    (ep = "ended") ~> (rec \in {"none", "stopped", "failed"})

Fairness ==
    /\ WF_vars(DispatchStart) /\ WF_vars(DispatchManualStop) /\ WF_vars(DispatchEndStop)
    /\ WF_vars(FinalizeEnd) /\ WF_vars(PublishCaptureStopped) /\ WF_vars(ApplyCaptureStopped)
    /\ WF_vars(CaptureFailedFact) /\ WF_vars(ApplyDeadlineStop)
    /\ WF_vars(LeaseExpires)
    /\ WF_vars(Recover)
    /\ WF_vars(ReservationEnds)
    /\ WF_vars(SalvageDeadlinePasses)
    /\ WF_vars(ExpireReservation)

Spec == Init /\ [][Next]_vars /\ Fairness

=============================================================================
