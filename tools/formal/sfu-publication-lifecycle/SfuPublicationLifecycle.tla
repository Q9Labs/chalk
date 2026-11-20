------------------- MODULE SfuPublicationLifecycle -------------------
(***************************************************************************)
(* The five-state local publication lifecycle of CloudflareSFUClient       *)
(* (sdks/typescript/client/src/media/client.ts): every owned publication   *)
(* moves pending -> confirmed -> held -> retiring -> retired, with         *)
(* reconnect, replacement and stop() racing asynchronous SFU responses.    *)
(*                                                                         *)
(* One media source is modeled; Slots are the publication objects the      *)
(* client keeps in #ownedPublications. At most one slot may be live at a   *)
(* time for the source, but a replacement may be pending while its         *)
(* predecessor is still retiring. A slot goes back to idle when the        *)
(* client drops it from #ownedPublications, so slots are reused.           *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Slots,     \* publication objects the client can own at once
    MaxHandle, \* bound on SFU publication ids minted per run
    Break      \* which broken variant to run; "none" is the real code

Phases == {"idle", "pending", "confirmed", "held", "retiring", "retired"}
Causes == {"user_pause", "forced_pause", "publish_failure", "replaced"}
LivePhases == {"pending", "confirmed", "held"}

VARIABLES
    phase,      \* [Slots -> Phases]
    handle,     \* [Slots -> 0..MaxHandle], 0 = no SFU publication id yet
    parked,     \* [Slots -> 0..MaxHandle], the handle a held publication keeps
    cause,      \* [Slots -> Causes \cup {"none"}], the retirement cause while retiring
    inFlight,   \* [Slots -> {0, 1}], a publish response may still arrive
    stopped,    \* the client's stop() ran
    mint,       \* next SFU publication id
    wasRetired, \* ghost: the slot's publication reached retired once
    retireAsked,\* ghost: the publication entered retiring once
    resumedAs   \* ghost: the parked handle a resume returned with

vars == <<phase, handle, parked, cause, inFlight, stopped, mint,
          wasRetired, retireAsked, resumedAs>>

TypeOK ==
    /\ phase \in [Slots -> Phases]
    /\ handle \in [Slots -> 0..MaxHandle]
    /\ parked \in [Slots -> 0..MaxHandle]
    /\ cause \in [Slots -> Causes \cup {"none"}]
    /\ inFlight \in [Slots -> {0, 1}]
    /\ stopped \in BOOLEAN
    /\ mint \in 1..(MaxHandle + 1)
    /\ wasRetired \in [Slots -> BOOLEAN]
    /\ retireAsked \in [Slots -> BOOLEAN]
    /\ resumedAs \in [Slots -> 0..MaxHandle]

Init ==
    /\ phase = [s \in Slots |-> "idle"]
    /\ handle = [s \in Slots |-> 0]
    /\ parked = [s \in Slots |-> 0]
    /\ cause = [s \in Slots |-> "none"]
    /\ inFlight = [s \in Slots |-> 0]
    /\ stopped = FALSE
    /\ mint = 1
    /\ wasRetired = [s \in Slots |-> FALSE]
    /\ retireAsked = [s \in Slots |-> FALSE]
    /\ resumedAs = [s \in Slots |-> 0]

\* #publishState: a new publication starts pending with the publish request
\* in flight. The publish path awaits `#retirement` before it publishes, so
\* a re-enable can only start once the previous retirement pass has settled
\* the old publication — by then it is held and the reusable find returns it
\* instead of publishing a second one.
Create(s) ==
    /\ phase[s] = "idle"
    /\ ~stopped
    /\ mint <= MaxHandle
    /\ IF Break = "spawn_while_live"
       THEN TRUE
       ELSE \A t \in Slots \ {s} : phase[t] \in {"idle", "retired"}
    /\ phase' = [phase EXCEPT ![s] = "pending"]
    /\ inFlight' = [inFlight EXCEPT ![s] = 1]
    /\ handle' = [handle EXCEPT ![s] = 0]
    /\ parked' = [parked EXCEPT ![s] = 0]
    /\ cause' = [cause EXCEPT ![s] = "none"]
    /\ wasRetired' = [wasRetired EXCEPT ![s] = FALSE]
    /\ retireAsked' = [retireAsked EXCEPT ![s] = FALSE]
    /\ resumedAs' = [resumedAs EXCEPT ![s] = 0]
    /\ UNCHANGED <<stopped, mint>>

\* The publish response lands: pending becomes confirmed with the id the
\* SFU assigned (#recordLocalPublicationHandles on a pending publication).
Confirm(s) ==
    /\ phase[s] = "pending" /\ inFlight[s] = 1
    /\ inFlight' = [inFlight EXCEPT ![s] = 0]
    /\ IF Break = "confirm_without_handle"
       THEN UNCHANGED <<handle, mint>>
       ELSE /\ handle' = [handle EXCEPT ![s] = mint]
            /\ mint' = mint + 1
    /\ phase' = [phase EXCEPT ![s] = "confirmed"]
    /\ UNCHANGED <<parked, cause, stopped, wasRetired, retireAsked, resumedAs>>

\* The publish request fails: the publication never got a handle and goes
\* straight to retiring with a publish_failure cause.
PublishFail(s) ==
    /\ phase[s] = "pending" /\ inFlight[s] = 1
    /\ phase' = [phase EXCEPT ![s] = "retiring"]
    /\ cause' = [cause EXCEPT ![s] = "publish_failure"]
    /\ inFlight' = [inFlight EXCEPT ![s] = 0]
    /\ retireAsked' = [retireAsked EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<handle, parked, stopped, mint, wasRetired, resumedAs>>

\* #markPublicationRetiring: a user pause or a forced close on a live
\* publication enters retiring. A held publication keeps its handle.
RetireStart(s) ==
    /\ phase[s] \in {"confirmed", "held"}
    /\ ~stopped
    /\ \E c \in {"user_pause", "forced_pause", "replaced"} :
        /\ cause' = [cause EXCEPT ![s] = c]
        /\ phase' = [phase EXCEPT ![s] = "retiring"]
    /\ retireAsked' = [retireAsked EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<handle, parked, inFlight, stopped, mint, wasRetired, resumedAs>>

\* A publish request was still in flight when the publication went retiring
\* (it was pending). The late response lands anyway: the real code attaches
\* the handle but stays retiring (`retiring ? { ...lifecycle, handle }`).
\* Stop wins: the response cannot bring the publication back to confirmed.
\* A pending publication can also be asked to retire while its publish
\* request is still in flight: #markPublicationRetiring accepts pending and
\* stores a null handle. The response may still land later (LateConfirm).
RetirePending(s) ==
    /\ phase[s] = "pending"
    /\ ~stopped
    /\ phase' = [phase EXCEPT ![s] = "retiring"]
    /\ \E c \in {"forced_pause", "publish_failure"} : cause' = [cause EXCEPT ![s] = c]
    /\ retireAsked' = [retireAsked EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<handle, parked, inFlight, stopped, mint, wasRetired, resumedAs>>

LateConfirm(s) ==
    /\ phase[s] = "retiring" /\ handle[s] = 0 /\ inFlight[s] = 1
    /\ inFlight' = [inFlight EXCEPT ![s] = 0]
    /\ IF Break = "retire_to_confirmed"
       THEN phase' = [phase EXCEPT ![s] = "confirmed"]
       ELSE phase' = phase
    /\ handle' = [handle EXCEPT ![s] = mint]
    /\ mint' = mint + 1
    /\ UNCHANGED <<parked, cause, stopped, wasRetired, retireAsked, resumedAs>>

\* #holdOwnedPublication: a user_pause retirement that may keep the bundle
\* transport parks the publication instead of closing it. The SFU
\* publication id stays live so a later resume needs no new publish.
Hold(s) ==
    /\ phase[s] = "retiring" /\ cause[s] = "user_pause" /\ handle[s] > 0
    /\ phase' = [phase EXCEPT ![s] = "held"]
    /\ parked' = [parked EXCEPT ![s] = handle[s]]
    /\ UNCHANGED <<handle, cause, inFlight, stopped, mint, wasRetired, resumedAs>>
    /\ retireAsked' = [retireAsked EXCEPT ![s] = FALSE]

\* #heldPublication reuse: a user resume of a parked publication confirms it
\* again with the same handle, no new publish request.
Resume(s) ==
    /\ phase[s] = "held"
    /\ ~stopped
    /\ resumedAs' = [resumedAs EXCEPT ![s] = parked[s]]
    /\ phase' = [phase EXCEPT ![s] = "confirmed"]
    /\ IF Break = "resume_new_handle"
       THEN /\ mint <= MaxHandle
            /\ handle' = [handle EXCEPT ![s] = mint]
            /\ mint' = mint + 1
       ELSE UNCHANGED <<handle, mint>>
    /\ UNCHANGED <<parked, cause, inFlight, stopped, wasRetired, retireAsked>>

\* A held publication cannot be reused after a connection replacement:
\* #heldPublication requires publication.connection === this.#connection,
\* so a reconnect retires a parked publication rather than resuming it.
Reconnect(s) ==
    /\ phase[s] \in {"confirmed", "held"}
    /\ ~stopped
    /\ phase' = [phase EXCEPT ![s] = "retiring"]
    /\ cause' = [cause EXCEPT ![s] = "replaced"]
    /\ retireAsked' = [retireAsked EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<handle, parked, inFlight, stopped, mint, wasRetired, resumedAs>>

\* The close completes: the publication is retired and dropped from
\* #ownedPublications (the slot goes idle for reuse). Only a retiring
\* publication with a handle is ever closed: #retiringOwnedPublications
\* filters on handle != null, so a publication retired while still pending
\* waits for its late response (LateConfirm) or for stop().
RetireDone(s) ==
    /\ phase[s] = "retiring" /\ handle[s] > 0
    /\ phase' = [phase EXCEPT ![s] = "retired"]
    /\ wasRetired' = [wasRetired EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<handle, parked, cause, inFlight, stopped, mint, retireAsked, resumedAs>>

\* A publish response that arrives after the publication is gone is ignored:
\* #recordLocalPublicationHandles skips retired publications, and the
\* stopped client has already dropped every publication.
DeadResponse(s) ==
    /\ phase[s] = "retired" /\ inFlight[s] = 1
    /\ IF Break = "stop_resurrect"
       THEN /\ phase' = [phase EXCEPT ![s] = "confirmed"]
            /\ handle' = [handle EXCEPT ![s] = mint]
            /\ mint' = mint + 1
            /\ inFlight' = [inFlight EXCEPT ![s] = 0]
       ELSE /\ inFlight' = [inFlight EXCEPT ![s] = 0]
            /\ UNCHANGED <<phase, handle, mint>>
    /\ UNCHANGED <<parked, cause, stopped, wasRetired, retireAsked, resumedAs>>

\* The freed slot is reused by the next publication.
Reap(s) ==
    /\ phase[s] = "retired" /\ inFlight[s] = 0
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ UNCHANGED <<handle, parked, cause, inFlight, stopped, mint, wasRetired, retireAsked, resumedAs>>

\* stop(): every owned publication is retired at once
\* (`for (const publication of this.#ownedPublications) lifecycle = retired`).
Stop ==
    /\ ~stopped
    /\ stopped' = TRUE
    /\ phase' = [s \in Slots |-> IF phase[s] \in {"idle", "retired"} THEN phase[s] ELSE "retired"]
    /\ wasRetired' = [s \in Slots |-> wasRetired[s] \/ phase[s] \notin {"idle", "retired"}]
    /\ UNCHANGED <<handle, parked, cause, inFlight, mint, retireAsked, resumedAs>>

Next ==
    \/ Stop
    \/ \E s \in Slots :
        \/ Create(s) \/ Confirm(s) \/ PublishFail(s) \/ RetirePending(s) \/ RetireStart(s)
        \/ LateConfirm(s) \/ Hold(s) \/ Resume(s) \/ Reconnect(s)
        \/ RetireDone(s) \/ DeadResponse(s) \/ Reap(s)

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Rules the code must keep.                                               *)
(***************************************************************************)

\* One source has at most one live publication: the reusable find returns a
\* confirmed or held publication before a new one is created.
AtMostOneLive ==
    Cardinality({s \in Slots : phase[s] \in LivePhases}) <= 1

\* Confirmed and held publications always carry the SFU publication id.
ConfirmedHasHandle ==
    \A s \in Slots : phase[s] \in {"confirmed", "held"} => handle[s] > 0

\* A parked publication keeps the handle it was confirmed with.
HeldKeepsHandle ==
    \A s \in Slots : phase[s] = "held" => handle[s] = parked[s] /\ parked[s] > 0

\* A resume returns with the same handle it was parked with: reuse must not
\* mint a second SFU publication for one source.
ResumedKeepsHandle ==
    \A s \in Slots : (phase[s] = "confirmed" /\ resumedAs[s] > 0) => handle[s] = resumedAs[s]

\* Stop wins: once a publication is asked to retire it can never come back
\* to a live phase — a late SFU response attaches a handle but cannot
\* resurrect it.
RetiringKeepsCourse ==
    \A s \in Slots : retireAsked[s] => phase[s] \notin LivePhases

\* After stop() nothing is left live.
StopRetiresAll ==
    stopped => \A s \in Slots : phase[s] \in {"idle", "retired"}

\* Retired is terminal: no late response or reconnect recreates the
\* publication inside the same slot.
RetiredStaysRetired ==
    \A s \in Slots : wasRetired[s] => phase[s] \in {"retired", "idle"}
=============================================================================
