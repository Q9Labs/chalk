------------------------- MODULE PublicInviteAccess -------------------------
(***************************************************************************)
(* One guest who arrives through a Space's public invite, and the access   *)
(* the API grants them: the arrival, the admission request, the Sync       *)
(* participant, and the grants the API hands out.                          *)
(*                                                                         *)
(* Each action is one database transaction or one call, as the code        *)
(* orders them. Paths are under apps/api/internal/ (see README.md for the  *)
(* action table). The guest's own requests run concurrently: a collection  *)
(* or an open-Space grant, a refresh and a Leave can all be in flight.     *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    Mode,    \* the Space's admission mode: "knock" or "open"
    MaxGen,  \* invite generations (each Rotate adds one)
    Break    \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "decide_not_fenced",        \* DecideAdmissionRequest drops the check that a reserved decision keeps its operation name
    "decide_skips_provenance",  \* DecideAdmissionRequest drops publicAdmissionProvenanceValid
    "collect_skips_provenance", \* UpdateArrivalState drops publicAdmissionProvenanceValid when collecting
    "transition_unchecked",     \* UpdateArrivalState drops arrivalTransitionAllowed
    "knock_ignores_archive",    \* CreateAdmissionRequest drops the space.ArchivedAt guard
    "join_ignores_archive",     \* JoinPublic drops the space.ArchivedAt guard
    "issue_skips_participant",  \* GetSyncTokenSubject drops the participant status and episodes.status = 'active' checks
    "open_turns_away",          \* ArrivalStatus turns a waiting guest away when the Space turns open
    "archive_without_second_end" \* LifecycleWorker.process drops the EndEpisode call after ArchiveSpace
}

ASSUME Mode \in {"knock", "open"} /\ MaxGen \in 1..3 /\ Break \in BreakNames

VARIABLES
    invGen,    \* space_public_invites.generation
    invOn,     \* space_public_invites.enabled
    archived,  \* spaces.archived_at is not null
    opened,    \* the host changed a knock Space to open while the guest waited
    lc,        \* auto Space lifecycle: "active", "ending" (Episode end requested), "sealed" (Space archived, second end not yet requested) or "archived"
    ep,        \* the Space's live Episode: "none", "active", "ending" or "ended"
    arr,       \* space_public_arrivals.state, "none" before the guest arrives
    arrGen,    \* the invite generation the arrival was created under
    arrExp,    \* space_public_arrivals.expires_at has passed
    sreq,      \* the Sync admission request (sync_admission_requests.status plus a reserved decision)
    part,      \* the guest's Sync participant: "none", "joining", "active", "leaving" or "gone"
    ops,       \* decision operations created for the request
    acq,       \* an admission acquire in flight (collection or open-Space grant): "idle", "read" or "granted"
    lv,        \* a Leave in flight: "idle" or "revoked" (the participant is leaving, the arrival not yet left)
    rf,        \* a refresh in flight: "idle" or "read"
    bad        \* accepted steps the rules forbid, see the rules

vars == <<invGen, invOn, archived, opened, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad>>

Terminal == {"rejected", "left", "unavailable"}

TypeOK ==
    /\ invGen \in 1..MaxGen /\ invOn \in BOOLEAN /\ archived \in BOOLEAN /\ opened \in BOOLEAN
    /\ lc \in {"active", "ending", "sealed", "archived"}
    /\ ep \in {"none", "active", "ending", "ended"}
    /\ arr \in {"none", "pending", "admitted"} \cup Terminal
    /\ arrGen \in 0..MaxGen /\ arrExp \in BOOLEAN
    /\ sreq \in {"none", "pending", "admit_reserved", "deny_reserved", "admitted", "denied", "expired"}
    /\ part \in {"none", "joining", "active", "leaving", "gone"}
    /\ ops \subseteq {"admit", "deny"}
    /\ acq \in {"idle", "read", "granted"} /\ lv \in {"idle", "revoked"} /\ rf \in {"idle", "read"}
    /\ bad \subseteq {"admit_invalid", "approve_invalid", "grant_inactive", "after_archive", "turned_away_by_open"}

Init ==
    /\ invGen = 1 /\ invOn = TRUE /\ archived = FALSE /\ opened = FALSE /\ lc = "active" /\ ep = "none"
    /\ arr = "none" /\ arrGen = 0 /\ arrExp = FALSE
    /\ sreq = "none" /\ part = "none" /\ ops = {}
    /\ acq = "idle" /\ lv = "idle" /\ rf = "idle" /\ bad = {}

(***************************************************************************)
(* Derived facts                                                           *)
(***************************************************************************)

\* publicAdmissionProvenanceValid (postgres/public_invites.go): the invite, Space, Episode and arrival
\* a knock decision or collection relies on are all still the ones the guest knocked on.
Provenance ==
    /\ Mode = "knock" /\ ~opened /\ ep = "active" /\ ~archived /\ invOn
    /\ arr = "pending" /\ ~arrExp /\ arrGen = invGen

\* arrivalTransitionAllowed (postgres/public_invites.go): a pending arrival goes anywhere, an
\* admitted one only to left or unavailable, and a terminal one stays.
Allowed(from, to) ==
    \/ from = to
    \/ (from = "pending" /\ to \in {"admitted", "rejected", "left", "unavailable"})
    \/ (from = "admitted" /\ to \in {"left", "unavailable"})

\* A join may create the Episode when none is live. An "ending" Episode still counts as live, so
\* a join then fails with ErrEpisodeNotActive (ensurePublicLiveEpisode, CreateAdmissionRequest).
CanJoinEpisode == ep \in {"none", "active", "ended"}

\* The token SQL (GetSyncTokenSubject) issues for an active participant of an active Episode. It also
\* issues for a joining participant on a live seat, but only without an admission request that is not
\* yet admitted. Here a joining participant always has a pending request, so it gets no token.
IssueAllowed == (part = "active" /\ ep = "active") \/ Break = "issue_skips_participant"

(***************************************************************************)
(* Space and invite actions (admins, time, the lifecycle worker)           *)
(***************************************************************************)

\* RotateSpacePublicInvite: a new handle and generation. Old tokens stop resolving.
Rotate ==
    /\ invGen < MaxGen /\ invGen' = invGen + 1
    /\ UNCHANGED <<invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

SetInviteEnabled ==
    /\ invOn' = ~invOn
    /\ UNCHANGED <<invGen, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

ArrivalExpires ==
    /\ arr = "pending" /\ ~arrExp /\ arrExp' = TRUE
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, sreq, part, ops, acq, lv, rf, bad, opened>>

\* The Sync request's own 5-minute lifetime ends (Sync marks the request expired and drops the joining seat).
RequestExpires ==
    /\ sreq = "pending" /\ sreq' = "expired"
    /\ part' = IF part = "joining" THEN "gone" ELSE part
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, ops, acq, lv, rf, bad, opened>>

\* lifecycle_worker.go process -> lifecycle_actions.go EndEpisode: request the end of the live Episode
\* (nothing to do when none is active), then ArchiveSpace in the same pass.
LifecycleEnd ==
    /\ lc = "active" /\ lc' = "ending"
    /\ ep' = IF ep = "active" THEN "ending" ELSE ep
    /\ UNCHANGED <<invGen, invOn, archived, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

\* Sync finishes ending the Episode: its participants go, its open admission requests expire.
SyncEndsEpisode ==
    /\ ep = "ending" /\ ep' = "ended"
    /\ part' = IF part \in {"joining", "active", "leaving"} THEN "gone" ELSE part
    /\ sreq' = IF sreq \in {"pending", "admit_reserved", "deny_reserved"} THEN "expired" ELSE sreq
    /\ UNCHANGED <<invGen, invOn, archived, lc, arr, arrGen, arrExp, ops, acq, lv, rf, bad, opened>>

\* spaces.ArchiveSpace archives the Space. It does not look at Episodes.
LifecycleArchive ==
    /\ lc = "ending" /\ archived' = TRUE
    /\ lc' = IF Break = "archive_without_second_end" THEN "archived" ELSE "sealed"
    /\ UNCHANGED <<invGen, invOn, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

\* lifecycle_worker.go process -> EndEpisode again, now that the archived Space takes no new guest: it
\* requests the end of any Episode a guest started between the first end and the archive.
LifecycleEndAfterArchive ==
    /\ lc = "sealed" /\ lc' = "archived"
    /\ ep' = IF ep = "active" THEN "ending" ELSE ep
    /\ UNCHANGED <<invGen, invOn, archived, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

\* The host ends the call: the Episode ends on its own, with no lifecycle worker.
HostEndsEpisode ==
    /\ ep = "active" /\ ep' = "ending"
    /\ UNCHANGED <<invGen, invOn, archived, lc, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

(***************************************************************************)
(* Arrival                                                                 *)
(***************************************************************************)

\* Runtime.Arrive with a new request key: ResolveInviteToken accepts only the current, enabled invite,
\* and an archived Space is refused. CreateArrival stores the generation.
Arrive ==
    /\ arr = "none" /\ invOn /\ ~archived
    /\ arr' = "pending" /\ arrGen' = invGen
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

(***************************************************************************)
(* Knock mode                                                              *)
(***************************************************************************)

\* PublicInviteRepository.CreateAdmissionRequest: one transaction under the invite, Space and arrival
\* locks. It creates the live Episode when none is live, and the joining participant.
Knock ==
    /\ Mode = "knock" /\ ~opened /\ sreq = "none" /\ arr = "pending" /\ CanJoinEpisode
    /\ (~archived \/ Break = "knock_ignores_archive")
    /\ invOn /\ ~arrExp /\ arrGen = invGen
    /\ ep' = "active" /\ sreq' = "pending" /\ part' = "joining"
    /\ bad' = IF archived THEN bad \cup {"after_archive"} ELSE bad
    /\ UNCHANGED <<invGen, invOn, archived, lc, arr, arrGen, arrExp, ops, acq, lv, rf, opened>>

\* PublicInviteRepository.DecideAdmissionRequest: reserve the decision on the pending request. A
\* reserved request keeps the operation name it has: the other decision is ErrAdmissionRequestTerminal.
DecideGuard ==
    \/ (sreq = "pending" /\ (Provenance \/ Break = "decide_skips_provenance"))
    \/ (Break = "decide_not_fenced" /\ sreq \in {"admit_reserved", "deny_reserved"})

Decide(d) ==
    /\ Mode = "knock" /\ DecideGuard
    /\ sreq' = IF d = "admit" THEN "admit_reserved" ELSE "deny_reserved"
    /\ ops' = ops \cup {d}
    /\ bad' = IF d = "admit" /\ ~Provenance THEN bad \cup {"approve_invalid"} ELSE bad
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, part, acq, lv, rf, opened>>

\* Sync's consumer applies the reserved decision (admit_participant or deny_admission).
SyncApply ==
    /\ sreq \in {"admit_reserved", "deny_reserved"}
    /\ IF sreq = "admit_reserved"
         THEN IF ep = "active"
                THEN sreq' = "admitted" /\ part' = IF part = "joining" THEN "active" ELSE part
                ELSE sreq' = "expired" /\ part' = IF part = "joining" THEN "gone" ELSE part
         ELSE sreq' = "denied" /\ part' = IF part = "joining" THEN "gone" ELSE part
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, ops, acq, lv, rf, bad, opened>>

\* resolvePendingAdmission, denied or expired request: the arrival ends.
CollectEnds ==
    /\ Mode = "knock" /\ arr = "pending" /\ sreq \in {"denied", "expired"}
    /\ arr' = IF sreq = "denied" THEN "rejected" ELSE "unavailable"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

\* resolvePendingAdmission, approved request: GrantPublicAccess finds the admitted participant (FindPublic)
\* and issues the grant. A participant that is gone, or an ended Episode, ends the arrival.
CollectGrant ==
    /\ Mode = "knock" /\ arr = "pending" /\ sreq = "admitted" /\ acq = "idle"
    /\ IF part = "active" /\ ep = "active"
         THEN acq' = "granted" /\ arr' = arr
         ELSE acq' = "idle" /\ arr' = "unavailable"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, lv, rf, bad, opened>>

\* UpdateArrivalState with RequirePending and State admitted: one transaction under the invite, Space,
\* Episode, arrival and participant locks. A failed check discards the grant, and the arrival ends.
CollectCommit ==
    /\ Mode = "knock" /\ acq = "granted"
    /\ LET valid == IF Break = "collect_skips_provenance"
                      THEN arr = "pending"
                      ELSE Provenance /\ part = "active"
       IN IF valid
            THEN /\ arr' = "admitted"
                 /\ bad' = IF ~Provenance THEN bad \cup {"admit_invalid"} ELSE bad
            ELSE /\ arr' = IF arr = "pending" THEN "unavailable" ELSE arr
                 /\ bad' = bad
    /\ acq' = "idle"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, lv, rf, opened>>

(***************************************************************************)
(* The host opens a knock Space                                            *)
(***************************************************************************)

\* The host changes the Space's admission policy from knock to open. Provenance then fails for a
\* pending knock request (it needs mode knock), so no host decision can reach it any more.
HostOpensSpace ==
    /\ Mode = "knock" /\ ~opened /\ opened' = TRUE
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad>>

\* Runtime.ArrivalStatus on a waiting guest in an opened Space: pendingGuestArrivalValid accepts open
\* mode, then admitPendingArrival grants access through JoinPublic and marks the arrival admitted.
OpenedAdmit ==
    /\ Mode = "knock" /\ opened /\ arr = "pending" /\ acq = "idle" /\ CanJoinEpisode
    /\ ~archived /\ invOn /\ ~arrExp /\ arrGen = invGen
    /\ arr' = "admitted" /\ ep' = "active" /\ part' = "active"
    /\ UNCHANGED <<invGen, invOn, archived, opened, lc, arrGen, arrExp, sreq, ops, acq, lv, rf, bad>>

\* The old pendingGuestArrivalValid refused every mode but knock, so the same poll turned the guest away.
OpenedTurnsAway ==
    /\ Break = "open_turns_away" /\ opened /\ arr = "pending"
    /\ arr' = "unavailable" /\ bad' = bad \cup {"turned_away_by_open"}
    /\ UNCHANGED <<invGen, invOn, archived, opened, lc, ep, arrGen, arrExp, sreq, part, ops, acq, lv, rf>>

(***************************************************************************)
(* Open mode                                                               *)
(***************************************************************************)

\* Runtime.Arrive (with an arrival handle, or right after CreateArrival): the handler read a pending
\* arrival in a Space that is not archived.
OpenRead ==
    /\ Mode = "open" /\ arr = "pending" /\ ~archived /\ acq = "idle"
    /\ acq' = "read"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, lv, rf, bad, opened>>

\* GrantPublicAccess -> JoinPublic: the Space lock refuses an archived Space, then it creates the live
\* Episode when none is live and an active participant. It never reads the arrival.
OpenGrant ==
    /\ Mode = "open" /\ acq = "read"
    /\ IF CanJoinEpisode /\ (~archived \/ Break = "join_ignores_archive")
         THEN /\ acq' = "granted" /\ ep' = "active" /\ part' = "active"
              /\ bad' = IF archived THEN bad \cup {"after_archive"} ELSE bad
         ELSE /\ acq' = "idle" /\ ep' = ep /\ part' = part /\ bad' = bad
    /\ UNCHANGED <<invGen, invOn, archived, lc, arr, arrGen, arrExp, sreq, ops, lv, rf, opened>>

\* UpdateArrivalState without RequirePending: only arrivalTransitionAllowed guards the write.
OpenCommit ==
    /\ Mode = "open" /\ acq = "granted"
    /\ IF Allowed(arr, "admitted") \/ Break = "transition_unchecked"
         THEN arr' = "admitted"
         ELSE arr' = arr
    /\ acq' = "idle"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, lv, rf, bad, opened>>

(***************************************************************************)
(* Leave, refresh                                                          *)
(***************************************************************************)

\* Runtime.Leave on a pending arrival: finishPendingArrival(unavailable, "cancelled").
LeavePending ==
    /\ arr = "pending" /\ arr' = "unavailable"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, acq, lv, rf, bad, opened>>

\* Runtime.Leave on an admitted arrival, first call: RevokePublicAccess -> LeavePublic marks the
\* participant leaving.
LeaveRevoke ==
    /\ arr = "admitted" /\ lv = "idle" /\ part = "active"
    /\ part' = "leaving" /\ lv' = "revoked"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, ops, acq, rf, bad, opened>>

\* Runtime.Leave, second call: UpdateArrivalState(left), checked by arrivalTransitionAllowed.
LeaveFinish ==
    /\ lv = "revoked" /\ lv' = "idle"
    /\ arr' = IF Allowed(arr, "left") \/ Break = "transition_unchecked" THEN "left" ELSE arr
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arrGen, arrExp, sreq, part, ops, acq, rf, bad, opened>>

\* Sync finishes the participant's leave.
SyncLeaves ==
    /\ part = "leaving" /\ part' = "gone"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, ops, acq, lv, rf, bad, opened>>

\* Runtime.RefreshAccess: the arrival is read as admitted, and the grant is issued later.
RefreshRead ==
    /\ arr = "admitted" /\ rf = "idle" /\ rf' = "read"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, bad, opened>>

\* issue: the Sync token SQL needs an active participant in an active Episode, in the same statement.
RefreshIssue ==
    /\ rf = "read" /\ rf' = "idle"
    /\ IssueAllowed
    /\ bad' = IF ~(part = "active" /\ ep = "active") THEN bad \cup {"grant_inactive"} ELSE bad
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, opened>>

RefreshFails ==
    /\ rf = "read" /\ ~IssueAllowed /\ rf' = "idle"
    /\ UNCHANGED <<invGen, invOn, archived, lc, ep, arr, arrGen, arrExp, sreq, part, ops, acq, lv, bad, opened>>

Done == UNCHANGED vars

Next ==
    \/ Rotate \/ SetInviteEnabled \/ ArrivalExpires \/ RequestExpires
    \/ LifecycleEnd \/ SyncEndsEpisode \/ LifecycleArchive \/ LifecycleEndAfterArchive \/ HostEndsEpisode
    \/ HostOpensSpace \/ OpenedAdmit \/ OpenedTurnsAway
    \/ Arrive \/ Knock \/ Decide("admit") \/ Decide("deny") \/ SyncApply
    \/ CollectEnds \/ CollectGrant \/ CollectCommit
    \/ OpenRead \/ OpenGrant \/ OpenCommit
    \/ LeavePending \/ LeaveRevoke \/ LeaveFinish \/ SyncLeaves
    \/ RefreshRead \/ RefreshIssue \/ RefreshFails
    \/ Done

(***************************************************************************)
(* Rules                                                                   *)
(***************************************************************************)

\* A guest is admitted only while the invite, Space, Episode and arrival they knocked on are all still valid.
AdmittedOnlyOnValidInvite == "admit_invalid" \notin bad

\* Approving never works on a request whose invite was rotated or disabled, or whose Space, Episode or arrival ended.
NoApprovalOfStaleRequest == "approve_invalid" \notin bad

\* A request has one decision: it is never both approved and denied.
DecisionOnce == ops # {"admit", "deny"}

\* A refresh grant goes only to an active participant of an active Episode.
NoGrantToInactiveParticipant == "grant_inactive" \notin bad

\* An archived Space takes no new knock and no new open-Space join.
NoNewAccessInArchivedSpace == "after_archive" \notin bad

\* An auto Space that the lifecycle worker archived has no Episode that nobody asked to end. The worker
\* requests the end ("ending") after it archives, when no new guest can start an Episode, so a join that
\* landed between the first end and the archive is ended too.
\* A guest who waits at a knock Space is not turned away when the host opens the Space.
OpenedRoomTurnsNoOneAway == "turned_away_by_open" \notin bad

ArchiveLeavesNoActiveEpisode == (lc = "archived") => ep # "active"

\* A rejected, left or unavailable arrival never changes, and an admitted one never goes back to pending.
TerminalStays ==
    [][ /\ arr \in Terminal => arr' = arr
        /\ arr = "admitted" => arr' \in {"admitted", "left", "unavailable"} ]_vars

Spec == Init /\ [][Next]_vars

=============================================================================
