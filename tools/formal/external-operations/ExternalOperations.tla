------------------------ MODULE ExternalOperations ------------------------
(***************************************************************************)
(* The Sync external-operation queue for one participant's one media       *)
(* source (the microphone), in one Episode: role transitions, publication  *)
(* grants, publication fences, remove-participant and end-Episode          *)
(* operations, and the provider-lane consumers that run them.              *)
(*                                                                         *)
(* Three things talk to the SFU about the source. The Live Episode process *)
(* asks for a grant (reserve, call the provider, complete). Three          *)
(* operations in `sync_external_operations` ask the provider to take the   *)
(* source away: "rt" is the role_transition_source_stop child of a         *)
(* role_transition_cleanup parent, "rem" is remove_participant and "end"   *)
(* is end_episode, tenant_end_episode or maximum_duration_expired. Every    *)
(* Sync node runs a provider-lane consumer that claims an operation for 60 *)
(* seconds, calls the provider, and finalizes in a separate transaction.   *)
(*                                                                         *)
(* Each Postgres action below is one transaction under the Episode control *)
(* row lock (`Authority.lock_control`, `for update`). The exception is     *)
(* Claim, which locks only the operation row (`for update skip locked`)    *)
(* and writes only `attempt_count` and the claim lease. The provider call  *)
(* is a message: it may arrive late, or never be answered in time, and the *)
(* caller then sees an ambiguous outcome. Paths are relative to            *)
(* apps/sync/lib/chalk_sync/.                                              *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, TLC

CONSTANTS
    Nodes,           \* Sync nodes, each with a provider-lane consumer
    Ops,             \* which provider operations run: a subset of {"rt", "rem", "end"}
    MaxAttempts,     \* stands for @max_attempts = 100
    MaxRev,          \* how many control revisions the model hands out
    MaxRoleChanges,  \* how many assign_roles commands the model runs
    Ordered,         \* the provider applies source controls in revision order (Chalk SFU)
    GrantRefusals,   \* the provider may refuse a grant for a reason other than a newer revoke
    GiveUp,          \* remove and end operations fail once attempt_count reaches MaxAttempts
    Crashes,         \* a node may stop in the middle of an operation (off for the liveness runs)
    Break            \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "claim_ignores_grant_source",    \* external_operation_claims.ex drops the `source is not null` reservation check
    "claim_ignores_grant_remove",    \* ... drops the remove_participant reservation check
    "reserve_ignores_capability",    \* publication_grants.ex reserve_transaction drops validate_capability
    "role_ignores_reservation",      \* role_transition_planner.ex drops lock_publication_reservations
    "finalize_ignores_status",       \* external_operation_finalizer.ex drops the `external.status != :pending` clause
    "pending_never_gives_up",        \* external_operation_consumer.ex drops `operation.attempt_count >= @max_attempts` from the :pending branch
    "rt_skips_provider",             \* external_operation_consumer.ex dispatches role_transition_source_stop as local
    "rem_skips_provider",            \* ... dispatches remove_participant as local
    "end_skips_provider",            \* ... dispatches end operations as local
    "grant_settles_stop",            \* publication_grants.ex complete_transaction settles the pending source stop when a grant fails
    "rt_gives_up",                   \* external_operation_consumer.ex fails a source stop after @max_attempts, as it does the other operations
    "resend_expired"                 \* publication_grants.ex reserve_transaction returns an expired open reservation instead of inserting a new one
}

ASSUME Nodes # {}
ASSUME Ops \subseteq {"rt", "rem", "end"}
ASSUME MaxAttempts \in Nat /\ MaxAttempts >= 1
ASSUME MaxRev \in Nat /\ MaxRev >= 3
ASSUME MaxRoleChanges \in Nat
ASSUME {Ordered, GrantRefusals, GiveUp, Crashes} \subseteq BOOLEAN
ASSUME Break \in BreakNames

VARIABLES
    ep,        \* episodes.status: "active", "ending" or "ended"
    part,      \* participants.status: "active", "leaving" or "gone" (left or removed)
    cap,       \* participants.capabilities holds publishAudio
    rc,        \* assign_roles commands that changed the role so far
    rev,       \* last value handed out by the sequence sync_source_control_revisions
    res,       \* newest sync_publication_grant_reservations row for the source
    resRev,    \* its control_revision
    resExp,    \* its expires_at has passed
    lp,        \* the Live Episode process behind the reservation
    gsent,     \* control revisions of grant requests sent to the provider
    gans,      \* the provider's recorded answer to each grant request
    pRev,      \* the provider's newest control revision for the source
    pState,    \* the provider's source authority: "none", "granted" or "revoked"
    pEnded,    \* the provider retired the Episode
    fence,     \* the sync_publication_fences row for the source: "none", "active" or "expired"
    fOwner,    \* external operation that owns that row
    st,        \* sync_external_operations.status of each operation
    orev,      \* its control_revision
    att,       \* its attempt_count
    claim,     \* node that holds its claim lease, or "none"
    osent,     \* the provider call for it was sent
    oans,      \* the provider ran it
    why,       \* why it failed: "none", "exhausted" or "obsolete"
    applied,   \* how many times its finalizer applied it
    nop,       \* the operation each node works on
    nph,       \* each node's progress on it
    natt       \* attempt_count each node read when it claimed

vars == <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent, gans,
          pRev, pState, pEnded, fence, fOwner, st, orev, att, claim, osent,
          oans, why, applied, nop, nph, natt>>

Revs == 1..MaxRev
Live == pState = "granted"
Blocking == res \in {"pending", "ambiguous"} /\ ~resExp
InFlight == \E r \in gsent : gans[r] = "none"

TypeOK ==
    /\ ep \in {"active", "ending", "ended"}
    /\ part \in {"active", "leaving", "gone"}
    /\ cap \in BOOLEAN
    /\ rc \in 0..MaxRoleChanges
    /\ rev \in 0..MaxRev
    /\ res \in {"none", "pending", "ambiguous", "confirmed", "failed"}
    /\ resRev \in 0..MaxRev
    /\ resExp \in BOOLEAN
    /\ lp \in {"none", "reserved", "sent", "done", "dead"}
    /\ gsent \subseteq Revs
    /\ gans \in [Revs -> {"none", "confirmed", "refused"}]
    /\ pRev \in 0..MaxRev
    /\ pState \in {"none", "granted", "revoked"}
    /\ pEnded \in BOOLEAN
    /\ fence \in {"none", "active", "expired"}
    /\ fOwner \in Ops \cup {"none"}
    /\ st \in [Ops -> {"none", "pending", "applied", "failed"}]
    /\ orev \in [Ops -> 0..MaxRev]
    /\ att \in [Ops -> 0..MaxAttempts]
    /\ claim \in [Ops -> Nodes \cup {"none"}]
    /\ osent \in [Ops -> BOOLEAN]
    /\ oans \in [Ops -> BOOLEAN]
    /\ why \in [Ops -> {"none", "exhausted", "obsolete"}]
    /\ applied \in [Ops -> 0..2]
    /\ nop \in [Nodes -> Ops \cup {"none"}]
    /\ nph \in [Nodes -> {"idle", "claimed", "sent", "got", "pending"}]
    /\ natt \in [Nodes -> 0..MaxAttempts]

(* The participant is active with publishAudio and has published nothing.   *)
Init ==
    /\ ep = "active"
    /\ part = "active"
    /\ cap = TRUE
    /\ rc = 0
    /\ rev = 0
    /\ res = "none"
    /\ resRev = 0
    /\ resExp = FALSE
    /\ lp = "none"
    /\ gsent = {}
    /\ gans = [r \in Revs |-> "none"]
    /\ pRev = 0
    /\ pState = "none"
    /\ pEnded = FALSE
    /\ fence = "none"
    /\ fOwner = "none"
    /\ st = [o \in Ops |-> "none"]
    /\ orev = [o \in Ops |-> 0]
    /\ att = [o \in Ops |-> 0]
    /\ claim = [o \in Ops |-> "none"]
    /\ osent = [o \in Ops |-> FALSE]
    /\ oans = [o \in Ops |-> FALSE]
    /\ why = [o \in Ops |-> "none"]
    /\ applied = [o \in Ops |-> 0]
    /\ nop = [n \in Nodes |-> "none"]
    /\ nph = [n \in Nodes |-> "idle"]
    /\ natt = [n \in Nodes |-> 0]

NodeSymmetry == Permutations(Nodes)

Min(a, b) == IF a < b THEN a ELSE b

(* The provider refuses a control whose revision is older than the one it  *)
(* holds for the source, and a grant at the revision of a revoke.          *)
Stale(r, isGrant) ==
    /\ Ordered
    /\ \/ r < pRev
       \/ r = pRev /\ pState = "revoked" /\ isGrant

(***************************************************************************)
(* Publication grants: publication_grants.ex, live/episode.ex              *)
(***************************************************************************)

(* reserve_transaction: Episode and participant active, capability held,   *)
(* no unexpired fence, and no unexpired pending or ambiguous reservation.  *)
(* Inserting the row takes the next control revision.                      *)
Reserve ==
    /\ ep = "active" /\ part = "active"
    /\ cap \/ Break = "reserve_ignores_capability"
    /\ fence # "active"
    /\ ~Blocking
    /\ lp \in {"none", "done", "dead"}
    /\ rev < MaxRev
    /\ rev' = rev + 1
    /\ res' = "pending" /\ resRev' = rev + 1 /\ resExp' = FALSE
    /\ lp' = "reserved"
    /\ UNCHANGED <<ep, part, cap, rc, gsent, gans, pRev, pState, pEnded, fence,
                   fOwner, st, orev, att, claim, osent, oans, why, applied,
                   nop, nph, natt>>

(* reserve_transaction with an operation id that already has a row: it     *)
(* returns that row, whatever its status, after the same actor checks but   *)
(* without the fence check. An open row that has expired is not returned:  *)
(* the insert replaces it with a new row and a new revision, which is the  *)
(* Reserve action.                                                         *)
ResendGrant ==
    /\ ep = "active" /\ part = "active" /\ cap
    /\ res # "none"
    /\ ~resExp \/ Break = "resend_expired"
    /\ lp \in {"done", "dead"}
    /\ lp' = "reserved"
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, gsent, gans,
                   pRev, pState, pEnded, fence, fOwner, st, orev, att, claim,
                   osent, oans, why, applied, nop, nph, natt>>

(* The Live Episode process calls the provider (module.grant_publication).  *)
SendGrant ==
    /\ lp = "reserved"
    /\ gsent' = gsent \cup {resRev}
    /\ lp' = "sent"
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, gans,
                   pRev, pState, pEnded, fence, fOwner, st, orev, att, claim,
                   osent, oans, why, applied, nop, nph, natt>>

(* The provider runs a grant request once and records its answer. A grant  *)
(* is refused when it is stale or the Episode is retired.                  *)
DeliverGrant ==
    \E r \in gsent :
        /\ gans[r] = "none"
        /\ \/ /\ ~pEnded /\ ~Stale(r, TRUE)
              /\ pState' = "granted" /\ pRev' = r
              /\ gans' = [gans EXCEPT ![r] = "confirmed"]
           \/ /\ pEnded \/ Stale(r, TRUE) \/ GrantRefusals
              /\ gans' = [gans EXCEPT ![r] = "refused"]
              /\ UNCHANGED <<pState, pRev>>
        /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, 
                       gsent, pEnded, fence, fOwner, st, orev, att, claim,
                       osent, oans, why, applied, nop, nph, natt>>

LiveDies ==
    /\ lp \in {"reserved", "sent"}
    /\ lp' = "dead"
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   claim, osent, oans, why, applied, nop, nph, natt>>

(* The reservation row passes its expires_at (30 seconds, or 5 minutes     *)
(* after a completion). The model assumes the provider has run, or will    *)
(* never run, the grant request by then.                                   *)
ExpireReservation ==
    /\ Blocking
    /\ ~InFlight
    /\ lp # "reserved"
    /\ resExp' = TRUE
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, lp, gsent, gans,
                   pRev, pState, pEnded, fence, fOwner, st, orev, att, claim,
                   osent, oans, why, applied, nop, nph, natt>>

(* The effects of finalizing operation o. A role-transition child settles *)
(* its parent, which deletes the fence row the parent owns. A failed      *)
(* role-transition cleanup keeps its fence row until it expires.          *)
FenceAfter(o) == IF fOwner = o THEN "none" ELSE fence
OwnerAfter(o) == IF fOwner = o THEN "none" ELSE fOwner

AppliedUpdate(o) ==
    /\ st' = [st EXCEPT ![o] = "applied"]
    /\ applied' = [applied EXCEPT ![o] = @ + 1]
    /\ fence' = FenceAfter(o) /\ fOwner' = OwnerAfter(o)
    /\ part' = IF o = "rt" THEN part ELSE "gone"
    /\ ep' = IF o = "end" THEN "ended" ELSE ep
    /\ why' = why

FailedUpdate(o, reason, restore) ==
    /\ st' = [st EXCEPT ![o] = "failed"]
    /\ why' = [why EXCEPT ![o] = reason]
    /\ applied' = applied
    /\ fence' = IF o = "rt" THEN fence ELSE FenceAfter(o)
    /\ fOwner' = IF o = "rt" THEN fOwner ELSE OwnerAfter(o)
    /\ part' = IF restore /\ o = "rem" THEN "active" ELSE part
    /\ ep' = IF restore /\ o = "end" THEN "active" ELSE ep

NoUpdate == UNCHANGED <<ep, part, st, applied, fence, fOwner, why>>

(* complete_transaction: store the outcome, then compare the participant   *)
(* with it. The pending role-transition child stays pending, because an   *)
(* earlier grant may still be live and only the provider can revoke it.    *)
(* Break "grant_settles_stop" settles the child as applied instead.        *)
CompleteGrant ==
    /\ lp = "sent"
    /\ \E out \in {"confirmed", "refused", "ambiguous"} :
        /\ \/ out = "ambiguous"
           \/ gans[resRev] = "confirmed" /\ out = "confirmed"
           \/ gans[resRev] = "refused" /\ out = "refused"
        /\ LET newStatus == IF res \in {"confirmed", "failed"} THEN res
                            ELSE CASE out = "confirmed" -> "confirmed"
                                   [] out = "refused"   -> "failed"
                                   [] OTHER              -> "ambiguous"
               cleanup == ~cap \/ fence = "active"
               satisfy == Break = "grant_settles_stop"
                          /\ newStatus = "failed" /\ cleanup /\ "rt" \in Ops
                          /\ st["rt"] = "pending"
           IN /\ res' = newStatus
              /\ resExp' = FALSE
              /\ lp' = "done"
              /\ IF satisfy THEN AppliedUpdate("rt") ELSE NoUpdate
    /\ UNCHANGED <<cap, rc, rev, resRev, gsent, gans, pRev, pState,
                   pEnded, orev, att, claim, osent, oans, nop, nph, natt>>

(***************************************************************************)
(* Commands that start operations                                          *)
(***************************************************************************)

(* assign_roles takes the publishAudio capability away                     *)
(* (role_transition_planner.ex). The command sees the publication as       *)
(* enabled when the provider shows it, or when an unexpired reservation    *)
(* exists. Then it commits the role change and a pending                   *)
(* role_transition_cleanup with its fence. The fence insert fails while    *)
(* another operation's unexpired fence holds the source.                   *)
RoleDemote ==
    /\ "rt" \in Ops
    /\ ep = "active" /\ part = "active" /\ cap /\ rc < MaxRoleChanges
    /\ LET exercised == (Live /\ ~pEnded)
                        \/ (res # "none" /\ ~resExp
                            /\ Break # "role_ignores_reservation")
       IN IF ~exercised
             THEN /\ cap' = FALSE /\ rc' = rc + 1
                  /\ UNCHANGED <<rev, st, orev, att, claim, osent, oans, why,
                                 applied, fence, fOwner>>
             ELSE /\ fence # "active"
                  /\ st["rt"] \in {"none", "applied", "failed"}
                  /\ rev < MaxRev
                  /\ cap' = FALSE /\ rc' = rc + 1
                  /\ rev' = rev + 1
                  /\ st' = [st EXCEPT !["rt"] = "pending"]
                  /\ orev' = [orev EXCEPT !["rt"] = rev + 1]
                  /\ att' = [att EXCEPT !["rt"] = 0]
                  /\ claim' = [claim EXCEPT !["rt"] = "none"]
                  /\ osent' = [osent EXCEPT !["rt"] = FALSE]
                  /\ oans' = [oans EXCEPT !["rt"] = FALSE]
                  /\ why' = [why EXCEPT !["rt"] = "none"]
                  /\ fence' = "active" /\ fOwner' = "rt"
                  /\ UNCHANGED applied
    /\ UNCHANGED <<ep, part, res, resRev, resExp, lp, gsent, gans, pRev,
                   pState, pEnded, nop, nph, natt>>

(* assign_roles gives the capability back. No source is lost, so no        *)
(* operation starts and no fence is checked.                               *)
RolePromote ==
    /\ ep = "active" /\ part = "active" /\ ~cap /\ rc < MaxRoleChanges
    /\ cap' = TRUE /\ rc' = rc + 1
    /\ UNCHANGED <<ep, part, rev, res, resRev, resExp, lp, gsent, gans,
                   pRev, pState, pEnded, fence, fOwner, st, orev, att, claim,
                   osent, oans, why, applied, nop, nph, natt>>

(* remove_participant is accepted: the participant is "leaving" and the    *)
(* operation takes the fence.                                              *)
AcceptRemove ==
    /\ "rem" \in Ops
    /\ ep = "active" /\ part = "active" /\ st["rem"] = "none"
    /\ fence # "active"
    /\ rev < MaxRev
    /\ rev' = rev + 1
    /\ part' = "leaving"
    /\ st' = [st EXCEPT !["rem"] = "pending"]
    /\ orev' = [orev EXCEPT !["rem"] = rev + 1]
    /\ fence' = "active" /\ fOwner' = "rem"
    /\ UNCHANGED <<ep, cap, rc, res, resRev, resExp, lp, gsent, gans,
                   pRev, pState, pEnded, att, claim, osent, oans, why, applied,
                   nop, nph, natt>>

(* An end operation is accepted: the Episode is "ending", and the          *)
(* operation fences every active participant.                              *)
AcceptEnd ==
    /\ "end" \in Ops
    /\ ep = "active" /\ st["end"] = "none"
    /\ part = "active" => fence # "active"
    /\ rev < MaxRev
    /\ rev' = rev + 1
    /\ ep' = "ending"
    /\ st' = [st EXCEPT !["end"] = "pending"]
    /\ orev' = [orev EXCEPT !["end"] = rev + 1]
    /\ IF part = "active"
          THEN fence' = "active" /\ fOwner' = "end"
          ELSE UNCHANGED <<fence, fOwner>>
    /\ UNCHANGED <<part, cap, rc, res, resRev, resExp, lp, gsent, gans,
                   pRev, pState, pEnded, att, claim, osent, oans, why, applied,
                   nop, nph, natt>>

FenceExpires ==
    /\ fence = "active"
    /\ fence' = "expired"
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fOwner, st, orev, att, claim,
                   osent, oans, why, applied, nop, nph, natt>>

(***************************************************************************)
(* The provider-lane consumer: external_operation_consumer.ex,             *)
(* sql/external_operation_claims.ex, postgres/external_operation_finalizer.ex *)
(***************************************************************************)

(* claim_operations_where: a pending operation whose claim lease has run   *)
(* out, unless a pending or ambiguous reservation blocks it. The block is  *)
(* per source for a role-transition child, per participant for            *)
(* remove_participant and per Episode for an end operation. This model has *)
(* one participant and one source, so all three blocks read the same row.  *)
Claim(n, o) ==
    /\ nph[n] = "idle"
    /\ st[o] = "pending"
    /\ claim[o] = "none"
    /\ ~(Blocking /\ ~(o = "rt" /\ Break = "claim_ignores_grant_source")
                  /\ ~(o = "rem" /\ Break = "claim_ignores_grant_remove"))
    /\ claim' = [claim EXCEPT ![o] = n]
    /\ att' = [att EXCEPT ![o] = Min(@ + 1, MaxAttempts)]
    /\ natt' = [natt EXCEPT ![n] = Min(att[o] + 1, MaxAttempts)]
    /\ nop' = [nop EXCEPT ![n] = o]
    /\ nph' = [nph EXCEPT ![n] = "claimed"]
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, osent,
                   oans, why, applied>>

ClaimLeaseExpires(o) ==
    /\ claim[o] # "none"
    /\ claim' = [claim EXCEPT ![o] = "none"]
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   osent, oans, why, applied, nop, nph, natt>>

SkipsProvider(o) ==
    \/ o = "rt" /\ Break = "rt_skips_provider"
    \/ o = "rem" /\ Break = "rem_skips_provider"
    \/ o = "end" /\ Break = "end_skips_provider"

(* dispatch: the node calls the provider, or treats the operation as local. *)
NodeCalls(n) ==
    /\ nph[n] = "claimed"
    /\ LET o == nop[n]
       IN IF SkipsProvider(o)
             THEN /\ nph' = [nph EXCEPT ![n] = "got"]
                  /\ UNCHANGED osent
             ELSE /\ nph' = [nph EXCEPT ![n] = "sent"]
                  /\ osent' = [osent EXCEPT ![o] = TRUE]
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   claim, oans, why, applied, nop, natt>>

(* The provider runs an operation once. A revoke or a remove is stale when *)
(* the provider already holds a newer grant; the provider still answers    *)
(* confirmed, because there is nothing left to take away.                  *)
ProviderRuns(o) ==
    /\ osent[o] /\ ~oans[o]
    /\ oans' = [oans EXCEPT ![o] = TRUE]
    /\ IF o = "end"
          THEN /\ pEnded' = TRUE /\ pState' = "revoked"
               /\ UNCHANGED pRev
          ELSE IF Stale(orev[o], FALSE)
                  THEN UNCHANGED <<pEnded, pState, pRev>>
                  ELSE /\ pState' = "revoked" /\ pRev' = orev[o]
                       /\ UNCHANGED pEnded
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, fence, fOwner, st, orev, att, claim, osent, why,
                   applied, nop, nph, natt>>

HearsAnswer(n) ==
    /\ nph[n] = "sent"
    /\ oans[nop[n]] /\ nph' = [nph EXCEPT ![n] = "got"]
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   claim, osent, oans, why, applied, nop, natt>>

NodeHears(n) ==
    /\ nph[n] = "sent"
    /\ \/ oans[nop[n]] /\ nph' = [nph EXCEPT ![n] = "got"]
       \/ nph' = [nph EXCEPT ![n] = "pending"]
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   claim, osent, oans, why, applied, nop, natt>>

NodeIdle(n) ==
    /\ nph' = [nph EXCEPT ![n] = "idle"]
    /\ nop' = [nop EXCEPT ![n] = "none"]
    /\ natt' = [natt EXCEPT ![n] = 0]

(* validate_finalization_authority: an end operation needs an "ending"     *)
(* Episode; the others need an "active" one, and a target participant      *)
(* that is active or leaving.                                              *)
AuthorityHolds(o) ==
    IF o = "end" THEN ep = "ending"
    ELSE ep = "active" /\ part \in {"active", "leaving"}

(* finalize_transaction with {:confirmed, :provider}. A duplicate finalize *)
(* finds the operation no longer pending. An authority error rolls back,   *)
(* until the claim that read attempt_count = MaxAttempts, which settles    *)
(* the operation as obsolete. A source stop whose target is gone settles   *)
(* as applied: the role change took effect and nothing can be live.        *)
NodeFinalizes(n) ==
    /\ nph[n] = "got"
    /\ LET o == nop[n]
       IN /\ NodeIdle(n)
          /\ IF st[o] # "pending" /\ Break # "finalize_ignores_status"
                THEN NoUpdate
             ELSE IF AuthorityHolds(o)
                THEN AppliedUpdate(o)
             ELSE IF att[o] >= MaxAttempts /\ GiveUp
                THEN IF o = "rt" /\ Break # "rt_gives_up"
                        THEN AppliedUpdate(o)
                        ELSE FailedUpdate(o, "obsolete", FALSE)
             ELSE NoUpdate
    /\ UNCHANGED <<rev, cap, rc, res, resRev, resExp, lp, gsent, gans,
                   pRev, pState, pEnded, orev, att, claim, osent, oans>>

(* The call stayed ambiguous. The operation stays pending for the next     *)
(* claim, until the claim that read attempt_count = MaxAttempts, which     *)
(* finalizes {:failed, :retry_exhausted}. A source stop never gives up:    *)
(* the role change has taken effect, so only the provider can settle it.   *)
NodePending(n) ==
    /\ nph[n] = "pending"
    /\ LET o == nop[n]
       IN /\ NodeIdle(n)
          /\ IF natt[n] >= MaxAttempts /\ GiveUp /\ st[o] = "pending"
                /\ Break # "pending_never_gives_up"
                /\ (o # "rt" \/ Break = "rt_gives_up")
                THEN IF AuthorityHolds(o)
                        THEN FailedUpdate(o, "exhausted", TRUE)
                        ELSE FailedUpdate(o, "obsolete", FALSE)
                ELSE NoUpdate
    /\ UNCHANGED <<rev, cap, rc, res, resRev, resExp, lp, gsent, gans,
                   pRev, pState, pEnded, orev, att, claim, osent, oans>>

(* The node stops, or the transaction fails: the claim stays until its     *)
(* lease runs out.                                                         *)
NodeStops(n) ==
    /\ Crashes
    /\ nph[n] # "idle"
    /\ NodeIdle(n)
    /\ UNCHANGED <<ep, part, cap, rc, rev, res, resRev, resExp, lp, gsent,
                   gans, pRev, pState, pEnded, fence, fOwner, st, orev, att,
                   claim, osent, oans, why, applied>>

(* Nothing is pending, so a quiet state is not a deadlock.                 *)
Done ==
    /\ \A o \in Ops : st[o] # "pending"
    /\ UNCHANGED vars

Next ==
    \/ Reserve
    \/ ResendGrant
    \/ SendGrant
    \/ DeliverGrant
    \/ LiveDies
    \/ ExpireReservation
    \/ CompleteGrant
    \/ RoleDemote
    \/ RolePromote
    \/ AcceptRemove
    \/ AcceptEnd
    \/ FenceExpires
    \/ \E n \in Nodes, o \in Ops : Claim(n, o)
    \/ \E o \in Ops : ClaimLeaseExpires(o)
    \/ \E n \in Nodes : NodeCalls(n)
    \/ \E o \in Ops : ProviderRuns(o)
    \/ \E n \in Nodes : NodeHears(n)
    \/ \E n \in Nodes : NodeFinalizes(n)
    \/ \E n \in Nodes : NodePending(n)
    \/ \E n \in Nodes : NodeStops(n)
    \/ Done

(* A source stop is retried until the provider answers, so the liveness    *)
(* run assumes the provider answers a source stop it receives often enough *)
(* (the strong fairness on HearsAnswer). Remove and end operations give up *)
(* and need no such assumption.                                            *)
Fairness ==
    /\ WF_vars(SendGrant) /\ WF_vars(DeliverGrant)
    /\ SF_vars(ExpireReservation) /\ WF_vars(CompleteGrant)
    /\ \A n \in Nodes, o \in Ops : SF_vars(Claim(n, o))
    /\ \A o \in Ops : WF_vars(ClaimLeaseExpires(o))
    /\ \A n \in Nodes : WF_vars(NodeCalls(n)) /\ WF_vars(NodeHears(n))
                        /\ WF_vars(NodeFinalizes(n)) /\ WF_vars(NodePending(n))
    /\ \A o \in Ops : WF_vars(ProviderRuns(o))
    /\ \A n \in Nodes : SF_vars(HearsAnswer(n) /\ nop[n] = "rt")
    /\ WF_vars(FenceExpires)

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* Rules                                                                   *)
(***************************************************************************)

(* A removed participant has no live source at the provider.               *)
RemovedNeverPublishes == part = "gone" => ~Live

(* A participant who lost publishAudio publishes only while the cleanup    *)
(* the role change started is still pending, or after Sync gave up on it.  *)
DemotedPublishesOnlyWhileCleanupRuns ==
    ("rt" \in Ops /\ ep = "active" /\ part = "active" /\ ~cap /\ Live)
        => st["rt"] \in {"pending", "failed"}

(* When Sync gives up on a role-transition cleanup, nothing is left live.  *)
GivingUpLeavesNothingLive ==
    ("rt" \in Ops /\ st["rt"] = "failed" /\ ep = "active" /\ part = "active" /\ ~cap)
        => ~Live

(* An ended Episode has no live source at the provider.                    *)
EndedNeverPublishes == ep = "ended" => ~Live

(* The finalizer applies an operation at most once.                        *)
AppliedOnce == \A o \in Ops : applied[o] <= 1

(* An operation that stays pending settles, even when the provider never  *)
(* gives a clear answer. A node that crashes forever settles nothing, so   *)
(* the runs that check this rule switch Crashes off.                       *)
OperationsSettle == \A o \in Ops : st[o] = "pending" ~> st[o] # "pending"

=============================================================================
