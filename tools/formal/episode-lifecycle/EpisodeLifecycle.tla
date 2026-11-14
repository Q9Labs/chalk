------------------------- MODULE EpisodeLifecycle -------------------------
(***************************************************************************)
(* One Chalk Episode from admission to the end, with the steps that can    *)
(* race an end: joins, knock admissions, Leaves, deadline changes and the  *)
(* ways an Episode ends.                                                   *)
(*                                                                         *)
(* Each action is one Postgres transaction under the Episode control row   *)
(* lock (Authority.lock_control, `for update`) and then the Episode row    *)
(* lock, in that order on the Sync side and on the API side. Sync paths    *)
(* are relative to apps/sync/lib/chalk_sync/stateholder/postgres/ and API  *)
(* paths to apps/api/internal/.                                            *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    People,   \* participants the model may create, one generation each
    MaxGen,   \* highest deadline generation the model reaches
    Break     \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "end_keeps_pending_joins",       \* supersede_pending_lifecycle_intents is not run
    "end_keeps_pending_admissions",  \* complete_external_episode_admissions is not run
    "end_keeps_participants",        \* complete_episode_participants is not run
    "admit_ignores_episode_status",  \* AdmitParticipant drops the episode.Status != active check
    "decision_ignores_status",       \* admission SQL drops its pending and reservation checks
    "deadline_race_unfenced",        \* an end no longer fences a deadline change, see StaleDeadlineCannotEnd
    "failed_end_blocks_claim"        \* ClaimDueEpisodeDeadlines skips a generation with a failed operation, see PastDeadlineGetsEnd
}

ASSUME IsFiniteSet(People) /\ People # {}
ASSUME MaxGen \in Nat /\ MaxGen >= 1
ASSUME Break \in BreakNames

VARIABLES
    ep,       \* episodes.status: "active", "ending" or "ended"
    ps,       \* participants.status of each person
    ji,       \* sync_lifecycle_intents.status of each person's participant_joined intent
    adm,      \* sync_admission_requests.status of each person's knock request
    res,      \* sync_admission_requests.decision_external_operation_id of each request
    decided,  \* how many times each request left "pending" (history, for AdmissionDecidedOnce)
    lv,       \* status of each person's participant_leave operation
    endOp,    \* the Episode end operation: its status, kind and deadline generation
    dl,       \* episodes.deadline_generation
    due,      \* episodes.deadline_at <= now() for the current generation
    dlOp,     \* the tenant_set_deadline operation: its status and requested generation
    tried,    \* generations with a maximum_episode_duration_expired operation that has not failed
    endedBy   \* the kind and generation of the end that completed, kind "none" before

vars == <<ep, ps, ji, adm, res, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

Gens == 1..MaxGen
PStat == {"none", "joining", "active", "leaving", "left"}
JStat == {"none", "pending", "applied", "superseded"}
AStat == {"none", "pending", "admitted", "denied", "expired"}
Res == {"none", "admit", "deny", "expire", "ended"}
OpStat == {"none", "pending", "applied", "failed"}
Kinds == {"user", "max"}

(* A failed maximum-duration operation no longer blocks its generation.    *)
FailedEndRetried ==
    IF endOp.kind = "max" /\ Break # "failed_end_blocks_claim" THEN tried \ {endOp.gen} ELSE tried

NoEnd == [status |-> "none", kind |-> "user", gen |-> 0]
NoDl == [status |-> "none", gen |-> 0]

TypeOK ==
    /\ ep \in {"active", "ending", "ended"}
    /\ ps \in [People -> PStat]
    /\ ji \in [People -> JStat]
    /\ adm \in [People -> AStat]
    /\ res \in [People -> Res]
    /\ decided \in [People -> 0..3]
    /\ lv \in [People -> OpStat]
    /\ endOp \in [status : OpStat, kind : Kinds, gen : 0..MaxGen]
    /\ dl \in Gens
    /\ due \in BOOLEAN
    /\ dlOp \in [status : OpStat, gen : 0..MaxGen]
    /\ tried \subseteq Gens
    /\ endedBy \in [kind : Kinds \cup {"none"}, gen : 0..MaxGen]

Init ==
    /\ ep = "active"
    /\ ps = [p \in People |-> "none"]
    /\ ji = [p \in People |-> "none"]
    /\ adm = [p \in People |-> "none"]
    /\ res = [p \in People |-> "none"]
    /\ decided = [p \in People |-> 0]
    /\ lv = [p \in People |-> "none"]
    /\ endOp = NoEnd
    /\ dl = 1
    /\ due = FALSE
    /\ dlOp = NoDl
    /\ tried = {}
    /\ endedBy = [kind |-> "none", gen |-> 0]

-----------------------------------------------------------------------------
(* API: joins and knock requests                                           *)

(* EpisodeLifecycleRepository.AdmitParticipant (adapters/postgres/         *)
(* episode_lifecycle_create.go) locks the control row, then the Episode,   *)
(* and returns ErrEpisodeNotActive unless `episode.Status` is "active". It *)
(* creates the participant in `joining` and a pending participant_joined   *)
(* intent.                                                                 *)
AdmitParticipant(p) ==
    /\ ps[p] = "none"
    /\ ep = "active" \/ Break = "admit_ignores_episode_status"
    /\ ps' = [ps EXCEPT ![p] = "joining"]
    /\ ji' = [ji EXCEPT ![p] = "pending"]
    /\ UNCHANGED <<ep, adm, res, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

(* The same, for a knock Space: the request is also stored pending in      *)
(* sync_admission_requests (public_episode_admission.go). The join intent  *)
(* can then only be applied by the admit decision, not by the consumer.    *)
RequestKnock(p) ==
    /\ ps[p] = "none"
    /\ ep = "active" \/ Break = "admit_ignores_episode_status"
    /\ ps' = [ps EXCEPT ![p] = "joining"]
    /\ ji' = [ji EXCEPT ![p] = "pending"]
    /\ adm' = [adm EXCEPT ![p] = "pending"]
    /\ UNCHANGED <<ep, res, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

(* LifecycleConsumer polls pending intents and calls Lifecycle.transaction *)
(* (lifecycle.ex). `validate_lifecycle_product_state` applies a            *)
(* participant_joined intent only when the Episode is "active" and the     *)
(* person is `joining`, and returns :episode_ending otherwise. A knock     *)
(* person's intent is applied by FinalizeDecision instead.                 *)
ApplyJoin(p) ==
    /\ ji[p] = "pending"
    /\ ps[p] = "joining"
    /\ adm[p] = "none"
    /\ ep = "active"
    /\ ps' = [ps EXCEPT ![p] = "active"]
    /\ ji' = [ji EXCEPT ![p] = "applied"]
    /\ UNCHANGED <<ep, adm, res, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

-----------------------------------------------------------------------------
(* Sync: admission decisions                                               *)

(* ExternalOperationPlanner.persist_pre_call_authority ->                  *)
(* reserve_admission_decision runs SQL.reserve_admission_request, which    *)
(* needs `status = 'pending' and decision_external_operation_id is null`.  *)
(* Admit and deny are host operations; expire is the internal              *)
(* admission_request_expired operation, due after the 5 minute             *)
(* AdmissionRequestLifetime (modeled as always possible, since time only   *)
(* moves forward).                                                         *)
ReserveDecision(p, d) ==
    /\ ep = "active"
    /\ \/ adm[p] = "pending" /\ res[p] = "none"
       \/ Break = "decision_ignores_status" /\ adm[p] # "none"
    /\ res' = [res EXCEPT ![p] = d]
    /\ UNCHANGED <<ep, ps, ji, adm, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

(* ExternalOperationFinalizer: finalize_admission_request needs            *)
(* `status = 'pending' and decision_external_operation_id = $6`, the       *)
(* Episode "active" (validate_finalization_episode), and then either       *)
(* applies the join (finalize_admission_approval) or supersedes the join   *)
(* intent and marks the person left (complete_denied_admission_product).   *)
FinalizeDecision(p) ==
    /\ ep = "active"
    /\ res[p] \in {"admit", "deny", "expire"}
    /\ adm[p] = "pending" \/ Break = "decision_ignores_status"
    /\ LET d == res[p] IN
       /\ adm' = [adm EXCEPT ![p] = CASE d = "admit" -> "admitted"
                                      [] d = "deny" -> "denied"
                                      [] OTHER -> "expired"]
       /\ ps' = [ps EXCEPT ![p] = IF d = "admit" THEN "active" ELSE "left"]
       /\ ji' = [ji EXCEPT ![p] = IF d = "admit" THEN "applied" ELSE "superseded"]
    /\ decided' = [decided EXCEPT ![p] = @ + 1]
    /\ UNCHANGED <<ep, res, lv, endOp, dl, due, dlOp, tried, endedBy>>

(* A decision operation fails (terminal failure or exhausted retries):     *)
(* release_failed_acceptance clears the reservation while the request is   *)
(* still pending.                                                          *)
ReleaseDecision(p) ==
    /\ res[p] \in {"admit", "deny", "expire"}
    /\ adm[p] = "pending"
    /\ res' = [res EXCEPT ![p] = "none"]
    /\ UNCHANGED <<ep, ps, ji, adm, decided, lv, endOp, dl, due, dlOp, tried, endedBy>>

-----------------------------------------------------------------------------
(* Sync: Leave                                                             *)

(* participant_leave acceptance (external_operation_planner.ex             *)
(* validate_leave_acceptance, mark_operation_participant_leaving) needs    *)
(* the person `active` and the Episode "active". sync-entry-leave covers   *)
(* the entry generations; this model only needs that a Leave is pending.   *)
AcceptLeave(p) ==
    /\ ep = "active"
    /\ ps[p] = "active"
    /\ lv[p] = "none"
    /\ ps' = [ps EXCEPT ![p] = "leaving"]
    /\ lv' = [lv EXCEPT ![p] = "pending"]
    /\ UNCHANGED <<ep, ji, adm, res, decided, endOp, dl, due, dlOp, tried, endedBy>>

(* complete_external_participant: needs `status = 'leaving'` and the       *)
(* Episode "active" (validate_finalization_episode).                       *)
FinalizeLeave(p) ==
    /\ ep = "active"
    /\ lv[p] = "pending"
    /\ ps[p] = "leaving"
    /\ ps' = [ps EXCEPT ![p] = "left"]
    /\ lv' = [lv EXCEPT ![p] = "applied"]
    /\ UNCHANGED <<ep, ji, adm, res, decided, endOp, dl, due, dlOp, tried, endedBy>>

(* A Leave fails while the person is still `leaving`:                      *)
(* release_failed_acceptance -> restore_participant_active.                *)
FailLeave(p) ==
    /\ lv[p] = "pending"
    /\ ps[p] = "leaving"
    /\ ps' = [ps EXCEPT ![p] = "active"]
    /\ lv' = [lv EXCEPT ![p] = "failed"]
    /\ UNCHANGED <<ep, ji, adm, res, decided, endOp, dl, due, dlOp, tried, endedBy>>

(* After the Episode ended, the Leave is obsolete: finalize_transaction    *)
(* returns :episode_ended on every retry, and after 100 attempts           *)
(* settle_exhausted_authority -> settle_obsolete marks it failed.          *)
SettleObsoleteLeave(p) ==
    /\ ep = "ended"
    /\ lv[p] = "pending"
    /\ lv' = [lv EXCEPT ![p] = "failed"]
    /\ UNCHANGED <<ep, ps, ji, adm, res, decided, endOp, dl, due, dlOp, tried, endedBy>>

-----------------------------------------------------------------------------
(* Deadline                                                                *)

(* Time passes beyond episodes.deadline_at for the current generation.     *)
DeadlineDue ==
    /\ ~due
    /\ due' = TRUE
    /\ UNCHANGED <<ep, ps, ji, adm, res, decided, lv, endOp, dl, dlOp, tried, endedBy>>

(* EpisodeLifecycleRepository.SetDeadline (episode_control.go) needs the   *)
(* Episode "active" and no pending tenant_set_deadline, and creates an     *)
(* operation for generation `dl + 1`.                                      *)
SetDeadline ==
    /\ ep = "active"
    /\ dlOp.status # "pending"
    /\ dl < MaxGen
    /\ dlOp' = [status |-> "pending", gen |-> dl + 1]
    /\ UNCHANGED <<ep, ps, ji, adm, res, decided, lv, endOp, dl, due, tried, endedBy>>

(* The Sync finalizer applies it (external_operation_finalizer.ex          *)
(* validate_finalization_deadline, update_deadline_product): the Episode   *)
(* must be "active" and the generation must be `deadline_generation + 1`.  *)
(* The new deadline lies in the future.                                    *)
FinalizeDeadline ==
    /\ \/ ep = "active"
       \/ Break = "deadline_race_unfenced" /\ ep = "ending"
    /\ dlOp.status = "pending"
    /\ dlOp.gen = dl + 1
    /\ dl' = dl + 1
    /\ due' = FALSE
    /\ dlOp' = [dlOp EXCEPT !.status = "applied"]
    /\ UNCHANGED <<ep, ps, ji, adm, res, decided, lv, endOp, tried, endedBy>>

-----------------------------------------------------------------------------
(* Ending                                                                  *)

(* A host presses End: the live path accepts an end_episode operation      *)
(* (external_operation_planner.ex prepare_end_operation,                   *)
(* mark_operation_episode_ending). Pending tenant_set_deadline operations  *)
(* stay pending.                                                           *)
AcceptUserEnd ==
    /\ ep = "active"
    /\ endOp.status # "pending"
    /\ ep' = "ending"
    /\ endOp' = [status |-> "pending", kind |-> "user", gen |-> 0]
    /\ UNCHANGED <<ps, ji, adm, res, decided, lv, dl, due, dlOp, tried, endedBy>>

(* DeadlineScheduler.runCycle -> EnqueueDueEpisodeDeadlines                *)
(* (adapters/postgres/episode_control.go). ClaimDueEpisodeDeadlines picks  *)
(* an "active" Episode whose deadline passed and that has no              *)
(* maximum_episode_duration_expired operation for the current generation   *)
(* that has not failed (a failed one is retried with a new request key     *)
(* after a backoff, which the model leaves out). createEndReadyOperation   *)
(* marks the Episode "ending" and fails pending tenant_set_deadline        *)
(* operations (FailPendingTenantControlOperationsForEnd).                  *)
EnqueueMaximumDuration ==
    /\ ep = "active"
    /\ due
    /\ endOp.status # "pending"
    /\ dl \notin tried
    /\ tried' = tried \cup {dl}
    /\ ep' = "ending"
    /\ endOp' = [status |-> "pending", kind |-> "max", gen |-> dl]
    /\ dlOp' = IF dlOp.status = "pending" /\ Break # "deadline_race_unfenced"
                THEN [dlOp EXCEPT !.status = "failed"]
                ELSE dlOp
    /\ UNCHANGED <<ps, ji, adm, res, decided, lv, dl, due, endedBy>>

(* finalize_with_authority -> finalize_external_fact -> complete_external_ *)
(* episode: the Episode becomes "ended"; complete_episode_participants     *)
(* marks every person who is not left as left; supersede_pending_          *)
(* lifecycle_intents supersedes pending join intents;                      *)
(* complete_external_episode_admissions expires pending requests.          *)
(* A maximum_duration_expired operation first passes                       *)
(* `stale_maximum_duration?`: its generation must be the current one.      *)
StaleMax ==
    /\ endOp.kind = "max"
    /\ endOp.gen # dl
    /\ Break # "deadline_race_unfenced"

CompleteEnd ==
    /\ ep = "ending"
    /\ endOp.status = "pending"
    /\ ~StaleMax
    /\ ep' = "ended"
    /\ endOp' = [endOp EXCEPT !.status = "applied"]
    /\ endedBy' = [kind |-> endOp.kind, gen |-> endOp.gen]
    /\ ps' = IF Break = "end_keeps_participants" THEN ps
             ELSE [p \in People |-> IF ps[p] = "none" THEN "none" ELSE "left"]
    /\ ji' = IF Break = "end_keeps_pending_joins" THEN ji
             ELSE [p \in People |-> IF ji[p] = "pending" THEN "superseded" ELSE ji[p]]
    /\ IF Break = "end_keeps_pending_admissions"
         THEN UNCHANGED <<adm, res, decided>>
         ELSE /\ adm' = [p \in People |-> IF adm[p] = "pending" THEN "expired" ELSE adm[p]]
              /\ res' = [p \in People |-> IF adm[p] = "pending" THEN "ended" ELSE res[p]]
              /\ decided' = [p \in People |-> IF adm[p] = "pending" THEN decided[p] + 1 ELSE decided[p]]
    /\ UNCHANGED <<lv, dl, due, dlOp, tried>>

(* settle_stale_maximum_duration: a maximum_duration_expired operation     *)
(* for an old generation fails and release_failed_acceptance               *)
(* (restore_episode_active) puts the Episode back to "active".             *)
RejectStaleEnd ==
    /\ ep = "ending"
    /\ endOp.status = "pending"
    /\ StaleMax
    /\ ep' = "active"
    /\ endOp' = [endOp EXCEPT !.status = "failed"]
    /\ tried' = FailedEndRetried
    /\ UNCHANGED <<ps, ji, adm, res, decided, lv, dl, due, dlOp, endedBy>>

(* The end operation cannot finish: ExternalOperationConsumer.             *)
(* execute_operation finalizes a still-pending operation as                *)
(* {:terminal_failure, :retry_exhausted} once attempt_count reaches 100    *)
(* (@max_attempts), for example while the media provider is down. The      *)
(* failure path is release_failed_acceptance -> restore_episode_active.    *)
EndRetriesExhausted ==
    /\ ep = "ending"
    /\ endOp.status = "pending"
    /\ ep' = "active"
    /\ endOp' = [endOp EXCEPT !.status = "failed"]
    /\ tried' = FailedEndRetried
    /\ UNCHANGED <<ps, ji, adm, res, decided, lv, dl, due, dlOp, endedBy>>

Done ==
    /\ ep = "ended"
    /\ \A p \in People : lv[p] # "pending"
    /\ UNCHANGED vars

UserStep ==
    \/ \E p \in People : AdmitParticipant(p) \/ RequestKnock(p) \/ AcceptLeave(p)
    \/ \E p \in People : \E d \in {"admit", "deny"} : ReserveDecision(p, d)
    \/ SetDeadline
    \/ AcceptUserEnd

SystemStep ==
    \/ \E p \in People : ApplyJoin(p) \/ FinalizeLeave(p) \/ FailLeave(p) \/ SettleObsoleteLeave(p)
    \/ \E p \in People : ReserveDecision(p, "expire") \/ FinalizeDecision(p) \/ ReleaseDecision(p)
    \/ DeadlineDue
    \/ FinalizeDeadline
    \/ EnqueueMaximumDuration
    \/ CompleteEnd
    \/ RejectStaleEnd
    \/ EndRetriesExhausted
    \/ Done

Next == UserStep \/ SystemStep

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules                                                                   *)

(* No person is joining, active or leaving in an ended Episode.            *)
NoPersonLiveAfterEnd ==
    ep = "ended" => \A p \in People : ps[p] \in {"none", "left"}

(* An end leaves no pending join intent and no pending admission request.  *)
EndClearsPending ==
    ep = "ended" => \A p \in People : ji[p] # "pending" /\ adm[p] # "pending"

(* A knock request leaves "pending" at most once.                          *)
AdmissionDecidedOnce ==
    \A p \in People : decided[p] <= 1

(* An Episode ends for the maximum duration only through the operation     *)
(* for the deadline generation it has when it ends.                        *)
StaleDeadlineCannotEnd ==
    endedBy.kind = "max" => endedBy.gen = dl

(* A passed deadline always has an end on the way or a retry coming. An   *)
(* "active" Episode past its deadline whose generation has only failed     *)
(* operations is picked up by ClaimDueEpisodeDeadlines again.              *)
PastDeadlineGetsEnd ==
    (ep = "active" /\ due) => dl \notin tried

=============================================================================
