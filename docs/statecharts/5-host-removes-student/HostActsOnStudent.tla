------------------------- MODULE HostActsOnStudent -------------------------
(***************************************************************************)
(* The host of a class (owner role) removes a student, or changes the     *)
(* student's role from collaborator to observer. A student with a camera  *)
(* on is in the class.                                                     *)
(*                                                                         *)
(* Code (paths under apps/sync/lib/chalk_sync/stateholder/postgres/):     *)
(*  role_transition_planner.ex:171  persist_pending_role_transition       *)
(*    commits the role change event, then installs publication fences and *)
(*    queues one source-stop child per lost source                        *)
(*  role_transition_settlement.ex:56-90  settle_role_transition_parent    *)
(*    a failed child fails the parent and rejects the receipt             *)
(*    (fail_role_transition_parent); only the applied branch deletes the  *)
(*    fences. Nothing undoes the role event.                              *)
(*  external_operation_finalizer.ex:26,1076  @max_attempts 100, then      *)
(*    restore_participant_active puts a failed removal back to active     *)
(*  apps/sync/lib/chalk_sync/episodes/reducer.ex:421  participant_left    *)
(***************************************************************************)
EXTENDS Naturals

VARIABLES
    op,       \* what the host asked for: "none", "remove" or "demote"
    hostSees, \* "idle", "working", "done" or "failed"
    student,  \* "in" or "gone"
    role,     \* the student's role: "collaborator" or "observer"
    camera    \* the student's camera as the call delivers it: "live" or "stopped"

vars == <<op, hostSees, student, role, camera>>

TypeOK ==
    /\ op \in {"none", "remove", "demote"}
    /\ hostSees \in {"idle", "working", "done", "failed"}
    /\ student \in {"in", "gone"}
    /\ role \in {"collaborator", "observer"}
    /\ camera \in {"live", "stopped"}

Init ==
    /\ op = "none"
    /\ hostSees = "idle"
    /\ student = "in"
    /\ role = "collaborator"
    /\ camera = "live"

HostPressesRemove ==
    /\ hostSees = "idle"
    /\ op' = "remove"
    /\ hostSees' = "working"
    /\ UNCHANGED <<student, role, camera>>

RemoveSucceeds ==
    /\ op = "remove" /\ hostSees = "working"
    /\ hostSees' = "done"
    /\ student' = "gone"
    /\ camera' = "stopped"
    /\ UNCHANGED <<op, role>>

\* After 100 attempts the removal is put back: the student is active again.
RemoveGivesUp ==
    /\ op = "remove" /\ hostSees = "working"
    /\ hostSees' = "failed"
    /\ UNCHANGED <<op, student, role, camera>>

\* The role event is committed at once. The camera stops later.
HostPressesDemote ==
    /\ hostSees = "idle"
    /\ op' = "demote"
    /\ hostSees' = "working"
    /\ role' = "observer"
    /\ UNCHANGED <<student, camera>>

DemoteSucceeds ==
    /\ op = "demote" /\ hostSees = "working"
    /\ hostSees' = "done"
    /\ camera' = "stopped"
    /\ UNCHANGED <<op, student, role>>

\* A source-stop child fails for good. The role event stays committed.
DemoteFails ==
    /\ op = "demote" /\ hostSees = "working"
    /\ hostSees' = "failed"
    /\ UNCHANGED <<op, student, role, camera>>

Done == hostSees \in {"done", "failed"} /\ UNCHANGED vars

Next ==
    \/ HostPressesRemove \/ RemoveSucceeds \/ RemoveGivesUp
    \/ HostPressesDemote \/ DemoteSucceeds \/ DemoteFails \/ Done

Spec == Init /\ [][Next]_vars

\* When the host sees "removed", the student is out of the class.
RemovedMeansOut == (op = "remove" /\ hostSees = "done") => (student = "gone" /\ camera = "stopped")

\* When the host has the outcome, a student who is an observer has no camera in the class.
ObserverHasNoCamera == (hostSees \in {"done", "failed"} /\ role = "observer") => camera = "stopped"

\* When the host sees "failed", nothing changed.
FailedMeansNothingChanged == hostSees = "failed" => (student = "in" /\ role = "collaborator")
=============================================================================
