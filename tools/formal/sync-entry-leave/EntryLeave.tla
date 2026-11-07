---------------------------- MODULE EntryLeave ----------------------------
(***************************************************************************)
(* Sync entry admission and Leave ordering for one participant generation. *)
(*                                                                         *)
(* One person (one `participants` row at one generation) has one or more   *)
(* sockets. Each socket entry gets an entry generation from                *)
(* `participant_join_seats`. Only the newest confirmed entry may Leave, a  *)
(* newer issued entry defers that Leave, and a newer confirmed entry       *)
(* supersedes it.                                                          *)
(*                                                                         *)
(* Every action is one Postgres transaction under the Episode control row  *)
(* lock (`Authority.lock_control`, `for update`), except ConsumerClaim.    *)
(* That claim runs `for update skip locked` on the operation row only and  *)
(* writes nothing but `attempt_count`, which AdmitNewEntry reads under the *)
(* control lock, so it is its own atomic step. Paths are relative to       *)
(* apps/sync/lib/chalk_sync/stateholder/postgres/.                         *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxEntry,   \* highest entry generation the model issues
    Consumers,  \* local-lane consumer nodes that can hold the same Leave
    Break       \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "admit_ignores_claimed_leave",   \* join_seats.ex validate_entry_dispatch always :ok
    "leave_never_defers",            \* join_seats.ex prepare_leave never returns :pending
    "defer_ignores_lease",           \* prepare_leave drops `issued_entry_expires_at > clock_timestamp()`
    "claim_ignores_lease",           \* claim_entry drops `issued_entry_expires_at > clock_timestamp()`
    "supersede_keeps_leaving",       \* claim_entry drops `update participants set status='active'`
    "supersede_own_leave"            \* claim_entry drops the `< $6` checks on CAS and supersede
}

ASSUME MaxEntry \in Nat /\ MaxEntry >= 2
ASSUME Break \in BreakNames

VARIABLES
    participant,  \* participants.status at this generation: "active", "leaving" or "left"
    issued,       \* participant_join_seats.issued_entry_generation
    confirmed,    \* participant_join_seats.confirmed_entry_generation
    issueLive,    \* participant_join_seats.issued_entry_expires_at > clock_timestamp()
    leave,        \* newest participant_leave row: status, payload entryGeneration, attempt_count > 0
    leaveCount,   \* number of participant_leave rows accepted so far; the newest one's id
    leftBy,       \* entryGeneration of the Leave that marked the person left, 0 before that
    consumer      \* each consumer node's progress on the Leave it claimed

vars == <<participant, issued, confirmed, issueLive, leave, leaveCount, leftBy, consumer>>

Entries == 1..MaxEntry
Statuses == {"none", "pending", "applied", "failed"}
NoLeave == [status |-> "none", entry |-> 0, claimed |-> FALSE]
Idle == [pc |-> "idle", id |-> 0]

TypeOK ==
    /\ participant \in {"active", "leaving", "left"}
    /\ issued \in Entries
    /\ confirmed \in Entries
    /\ confirmed <= issued
    /\ issueLive \in BOOLEAN
    /\ leave \in [status : Statuses, entry : 0..MaxEntry, claimed : BOOLEAN]
    /\ leaveCount \in 0..MaxEntry
    /\ leftBy \in 0..MaxEntry
    /\ consumer \in [Consumers -> [pc : {"idle", "claimed", "ready"}, id : 0..MaxEntry]]

(* The person has joined with entry 1 and that entry is confirmed. Its issue *)
(* lease may still run or may have expired.                                *)
Init ==
    /\ participant = "active"
    /\ issued = 1
    /\ confirmed = 1
    /\ issueLive \in BOOLEAN
    /\ leave = NoLeave
    /\ leaveCount = 0
    /\ leftBy = 0
    /\ consumer = [c \in Consumers |-> Idle]

(* join_seats.ex prepare_leave: `[["pending", true]] -> :pending` when       *)
(* `seat.issued_entry_generation > entryGeneration and                     *)
(* seat.issued_entry_expires_at > clock_timestamp()`.                      *)
Defers(entry) ==
    CASE Break = "leave_never_defers" -> FALSE
      [] Break = "defer_ignores_lease" -> issued > entry
      [] OTHER -> issued > entry /\ issueLive

-----------------------------------------------------------------------------
(* Socket actions                                                          *)

(* A new socket asks for a new entry: Stateholder.admit_entry ->           *)
(* JoinSeats.admit_entry (join_seats.ex), `allocate_entry` with :new. It   *)
(* needs the participant at this generation in joining, active or leaving, *)
(* and `validate_entry_dispatch` rolls back with :admission_pending while a *)
(* claimed (attempt_count > 0) participant_leave is pending. The increment *)
(* also restarts the 120-second issue lease. The model starts after join,  *)
(* so "joining" does not occur.                                            *)
AdmitNewEntry ==
    /\ participant \in {"active", "leaving"}
    /\ issued < MaxEntry
    /\ Break = "admit_ignores_claimed_leave" \/ ~(leave.status = "pending" /\ leave.claimed)
    /\ issued' = issued + 1
    /\ issueLive' = TRUE
    /\ UNCHANGED <<participant, confirmed, leave, leaveCount, leftBy, consumer>>

(* Time passes beyond issued_entry_expires_at.                             *)
IssueLeaseExpires ==
    /\ issueLive
    /\ issueLive' = FALSE
    /\ UNCHANGED <<participant, issued, confirmed, leave, leaveCount, leftBy, consumer>>

(* The socket holding entry e confirms its join: Lifecycle.transaction     *)
(* (lifecycle.ex) calls JoinSeats.claim_entry once the join intent is      *)
(* applied. claim_entry does not read participants.status. It accepts e    *)
(* when `e <= issued` and `confirmed >= e or issued_entry_expires_at >     *)
(* clock_timestamp()`. Its CAS moves confirmed to e when `confirmed < e`,  *)
(* marks a pending Leave with `entryGeneration < e` failed and removes its *)
(* fence, rejects its receipt, and puts a leaving participant back to      *)
(* active when it superseded a Leave. A claim that changes nothing is a    *)
(* stutter and is left out.                                                *)
ClaimEntry(e) ==
    LET leaseOk == Break = "claim_ignores_lease" \/ confirmed >= e \/ issueLive
        casOk == IF Break = "supersede_own_leave" THEN TRUE ELSE confirmed < e
        supersedes == /\ leave.status = "pending"
                      /\ (Break = "supersede_own_leave" \/ leave.entry < e)
        restores == supersedes /\ participant = "leaving" /\ Break # "supersede_keeps_leaving"
    IN /\ e \in 1..issued
       /\ leaseOk
       /\ casOk
       /\ (confirmed # e \/ supersedes)
       /\ confirmed' = e
       /\ leave' = IF supersedes THEN [leave EXCEPT !.status = "failed"] ELSE leave
       /\ participant' = IF restores THEN "active" ELSE participant
       /\ UNCHANGED <<issued, issueLive, leaveCount, leftBy, consumer>>

(* The socket holding entry e sends Leave:                                 *)
(* ExternalOperationPlanner.accept_transaction (external_operation_planner *)
(* .ex). JoinSeats.validate_leave rejects with :participant_inactive unless *)
(* e is the confirmed entry, and validate_leave_acceptance needs the       *)
(* participant active. Acceptance inserts the pending operation with       *)
(* `entryGeneration = e` and marks the participant leaving                 *)
(* (`mark_participant_leaving`). In the same transaction                   *)
(* finalize_local_leave calls JoinSeats.prepare_leave: on :ready it        *)
(* finalizes at once (ExternalOperationFinalizer.finalize_transaction,     *)
(* `complete_external_participant`), on :pending the Leave waits for the   *)
(* consumer.                                                               *)
AcceptLeave(e) ==
    /\ e = confirmed
    /\ participant = "active"
    /\ leaveCount < MaxEntry
    /\ leaveCount' = leaveCount + 1
    /\ IF Defers(e)
          THEN /\ leave' = [status |-> "pending", entry |-> e, claimed |-> FALSE]
               /\ participant' = "leaving"
               /\ UNCHANGED leftBy
          ELSE /\ leave' = [status |-> "applied", entry |-> e, claimed |-> FALSE]
               /\ participant' = "left"
               /\ leftBy' = e
    /\ UNCHANGED <<issued, confirmed, issueLive, consumer>>

-----------------------------------------------------------------------------
(* Local-lane consumer actions (external_operation_consumer.ex)            *)

(* claim_local_operations (sql/external_operation_claims.ex) picks the     *)
(* pending row `for update skip locked` and sets `attempt_count =          *)
(* least(attempt_count + 1, 100)` and a 60-second lease. A second node can *)
(* claim the same row after that lease while the first still holds it, so  *)
(* the model lets any idle node claim at any time.                         *)
ConsumerClaim(c) ==
    /\ consumer[c].pc = "idle"
    /\ leave.status = "pending"
    /\ leave' = [leave EXCEPT !.claimed = TRUE]
    /\ consumer' = [consumer EXCEPT ![c] = [pc |-> "claimed", id |-> leaveCount]]
    /\ UNCHANGED <<participant, issued, confirmed, issueLive, leaveCount, leftBy>>

(* dispatch_with_context -> Stateholder.prepare_entry_leave ->             *)
(* JoinSeats.prepare_leave, its own transaction. :superseded becomes a     *)
(* terminal failure whose finalize finds the row no longer pending, and    *)
(* :pending leaves the row for a later claim; both free the node. :ready   *)
(* goes on to finalize in a later transaction.                             *)
ConsumerPrepare(c) ==
    /\ consumer[c].pc = "claimed"
    /\ LET mine == consumer[c].id = leaveCount /\ leave.status = "pending"
       IN consumer' = [consumer EXCEPT ![c] =
              IF mine /\ ~Defers(leave.entry) THEN [@ EXCEPT !.pc = "ready"] ELSE Idle]
    /\ UNCHANGED <<participant, issued, confirmed, issueLive, leave, leaveCount, leftBy>>

(* finalize_confirmed -> ExternalOperationFinalizer.finalize_transaction   *)
(* with {:confirmed, :local}. A row that is no longer pending is a         *)
(* duplicate. Otherwise `complete_external_participant` marks the person   *)
(* left only while they are leaving and the seat's confirmed entry still   *)
(* equals entryGeneration; when it updates no row the transaction rolls    *)
(* back and the row stays pending.                                         *)
ConsumerFinalize(c) ==
    /\ consumer[c].pc = "ready"
    /\ consumer' = [consumer EXCEPT ![c] = Idle]
    /\ IF /\ consumer[c].id = leaveCount
          /\ leave.status = "pending"
          /\ participant = "leaving"
          /\ confirmed = leave.entry
          THEN /\ leave' = [leave EXCEPT !.status = "applied"]
               /\ participant' = "left"
               /\ leftBy' = leave.entry
          ELSE UNCHANGED <<leave, participant, leftBy>>
    /\ UNCHANGED <<issued, confirmed, issueLive, leaveCount>>

(* A node crashes, times out, or its transaction fails (prepare errors     *)
(* return :pending in postgres.ex prepare_entry_leave). The row stays      *)
(* pending and claimable.                                                  *)
ConsumerAbandons(c) ==
    /\ consumer[c].pc # "idle"
    /\ consumer' = [consumer EXCEPT ![c] = Idle]
    /\ UNCHANGED <<participant, issued, confirmed, issueLive, leave, leaveCount, leftBy>>

(* The person has left and no node holds work: nothing more can happen.    *)
Done ==
    /\ participant = "left"
    /\ \A c \in Consumers : consumer[c].pc = "idle"
    /\ UNCHANGED vars

Next ==
    \/ AdmitNewEntry
    \/ IssueLeaseExpires
    \/ \E e \in Entries : ClaimEntry(e)
    \/ \E e \in Entries : AcceptLeave(e)
    \/ \E c \in Consumers : ConsumerClaim(c)
    \/ \E c \in Consumers : ConsumerPrepare(c)
    \/ \E c \in Consumers : ConsumerFinalize(c)
    \/ \E c \in Consumers : ConsumerAbandons(c)
    \/ Done

(* Time passes, and some node keeps retrying the Leave. A crash may repeat *)
(* any number of times, so the consumer steps are strongly fair.           *)
Fairness ==
    /\ WF_vars(IssueLeaseExpires)
    /\ \A c \in Consumers :
          /\ SF_vars(ConsumerClaim(c))
          /\ SF_vars(ConsumerPrepare(c))
          /\ SF_vars(ConsumerFinalize(c))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Rules                                                                   *)

(* A person is marked left only by a Leave from their newest confirmed     *)
(* entry, and no newer entry is confirmed after that. If this breaks, a    *)
(* reloaded tab or second device thinks it is in the call while the roster, *)
(* attendance and the participant.left webhook say the person left, and    *)
(* leave cleanup removes their media.                                      *)
LeftOnlyByNewestEntry ==
    participant = "left" => leftBy = confirmed

(* A Leave is cancelled only because a newer entry of the same person was  *)
(* confirmed. If this breaks, a person who pressed Leave stays in the call  *)
(* with nothing newer to explain it.                                       *)
CancelledOnlyByNewerEntry ==
    leave.status = "failed" => confirmed > leave.entry

(* The person shows as leaving exactly while a Leave is pending. If this   *)
(* breaks, the person is stuck as leaving: they cannot Leave again         *)
(* (validate_leave_acceptance needs active) and nothing will finish it.    *)
LeavingOnlyWhileLeavePending ==
    participant = "leaving" <=> leave.status = "pending"

(* Every accepted Leave ends, applied or superseded. If this breaks, the   *)
(* person who pressed Leave stays in the roster and their client waits on  *)
(* the receipt.                                                            *)
LeaveEnds ==
    leave.status = "pending" ~> leave.status \in {"applied", "failed"}

=============================================================================
