---------------------------- MODULE ClassEnds ----------------------------
(***************************************************************************)
(* A class with automatic recording runs, then it ends: the host presses   *)
(* "End call for everyone", or the time limit arrives. After that the      *)
(* recording is built and either becomes ready or fails.                   *)
(*                                                                         *)
(* The host here has the owner role (a dashboard Space). The Start-a-call  *)
(* starter has no End button at all, see the StartClass chart.             *)
(*                                                                         *)
(* Code:                                                                   *)
(*  apps/api/internal/adapters/postgres/episode_control.go                 *)
(*    EnqueueDueEpisodeDeadlines (109), createEndReadyOperation (304)      *)
(*  apps/sync/lib/chalk_sync/stateholder/postgres/                         *)
(*    external_operation_finalizer.ex  @max_attempts 100 (26),             *)
(*    release_failed_acceptance (1093)                                     *)
(*  apps/sync/lib/chalk_sync/episodes/reducer.ex:592                       *)
(*    episode_ended empties the participants and clears the recording      *)
(*  apps/sync/lib/chalk_sync/stateholder/postgres/lifecycle.ex:181         *)
(*    the automatic recording starts with the first participant_joined     *)
(*  apps/api/internal/recordingpipeline/state.go, types.go:25-26           *)
(*    capture, render, verify; render attempts DefaultRenderAttemptLimit 3 *)
(*  sdks/typescript/client/src/space-client/failure-detail.ts:21           *)
(*    "Recording failed. Try again."                                       *)
(***************************************************************************)
EXTENDS Naturals

VARIABLES
    call,   \* "running", "ending" (End accepted, cleanup under way) or "ended"
    rec,    \* the recording, see Recs
    tries   \* render attempts used so far

vars == <<call, rec, tries>>

Recs == {"recording", "recordingFailed", "building", "retrying", "ready", "lost"}

TypeOK ==
    /\ call \in {"running", "ending", "ended"}
    /\ rec \in Recs
    /\ tries \in 0..3

Init == call = "running" /\ rec = "recording" /\ tries = 0

HostPressesEnd ==
    /\ call = "running"
    /\ call' = "ending"
    /\ UNCHANGED <<rec, tries>>

TimeLimitArrives ==
    /\ call = "running"
    /\ call' = "ending"
    /\ UNCHANGED <<rec, tries>>

\* The end cleanup finishes. The episode_ended event empties the room and
\* clears the live recording status, and the recording pipeline takes over.
EndSucceeds ==
    /\ call = "ending"
    /\ call' = "ended"
    /\ rec' = CASE rec = "recording" -> "building"
                [] rec = "recordingFailed" -> "lost"
                [] OTHER -> rec
    /\ UNCHANGED tries

\* After 100 failed attempts the end is given up and the class runs again.
EndGivesUp ==
    /\ call = "ending"
    /\ call' = "running"
    /\ UNCHANGED <<rec, tries>>

CaptureFails ==
    /\ call \in {"running", "ending"}
    /\ rec = "recording"
    /\ rec' = "recordingFailed"
    /\ UNCHANGED <<call, tries>>

HostRestartsRecording ==
    /\ call = "running"
    /\ rec = "recordingFailed"
    /\ rec' = "recording"
    /\ UNCHANGED <<call, tries>>

BuildSucceeds ==
    /\ rec = "building"
    /\ rec' = "ready"
    /\ UNCHANGED <<call, tries>>

BuildFails ==
    /\ rec = "building"
    /\ rec' = "retrying"
    /\ tries' = tries + 1
    /\ UNCHANGED call

BuildRetries ==
    /\ rec = "retrying"
    /\ tries < 3
    /\ rec' = "building"
    /\ UNCHANGED <<call, tries>>

BuildGivesUp ==
    /\ rec = "retrying"
    /\ tries = 3
    /\ rec' = "lost"
    /\ UNCHANGED <<call, tries>>

Done == (call = "ended" /\ rec \in {"ready", "lost"}) /\ UNCHANGED vars

Next ==
    \/ HostPressesEnd \/ TimeLimitArrives \/ EndSucceeds \/ EndGivesUp
    \/ CaptureFails \/ HostRestartsRecording
    \/ BuildSucceeds \/ BuildFails \/ BuildRetries \/ BuildGivesUp \/ Done

Spec == Init /\ [][Next]_vars

\* When the call has ended, nothing is still recording it live.
EndedMeansRecordingClosed == call = "ended" => rec \notin {"recording", "recordingFailed"}

\* The recording only gets built after the class ended.
BuildOnlyAfterEnd == rec \in {"building", "retrying", "ready"} => call = "ended"

\* An ended call never runs again.
EndedIsFinal == [][call = "ended" => call' = "ended"]_vars
=============================================================================
