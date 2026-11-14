---------------------------- MODULE StartClass ----------------------------
(***************************************************************************)
(* A person opens chalk.live, presses "Start call", and ends up in a call. *)
(*                                                                         *)
(* Code: apps/web/src/components/space/SpacePage.tsx (start, arrive),      *)
(* apps/web/src/lib/chalk-access.ts:50 (a new request key for every       *)
(* press), apps/api/internal/publicinvites/service.go:819                  *)
(* (CreatePublicSpace), apps/api/internal/publicinviteapp/access.go:149    *)
(* (the starter joins as "collaborator"), apps/api/db/queries/spaces.sql   *)
(* (the capabilities of that role).                                        *)
(*                                                                         *)
(* StarterCanEnd is the capability "endEpisode" of the starter's role. The *)
(* real value is FALSE: "collaborator" has no host powers.                 *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxPresses,    \* how many times the person may press Start call
    StarterCanEnd  \* does the role the starter joins with include endEpisode?

VARIABLES
    screen,   \* what the person sees
    rooms,    \* calls (Spaces) that now exist because of this person
    presses   \* Start call presses so far

vars == <<screen, rooms, presses>>

Screens == {"home", "starting", "joining", "live", "startFailed", "joinFailed"}

TypeOK ==
    /\ screen \in Screens
    /\ rooms \in 0..MaxPresses
    /\ presses \in 0..MaxPresses

Init == screen = "home" /\ rooms = 0 /\ presses = 0

PressStart ==
    /\ screen \in {"home", "startFailed"}
    /\ presses < MaxPresses
    /\ screen' = "starting"
    /\ presses' = presses + 1
    /\ UNCHANGED rooms

RoomMade ==
    /\ screen = "starting"
    /\ screen' = "joining"
    /\ rooms' = rooms + 1
    /\ UNCHANGED presses

ResponseLost ==
    /\ screen = "starting"
    /\ screen' = "startFailed"
    /\ rooms' = rooms + 1
    /\ UNCHANGED presses

RequestRejected ==
    /\ screen = "starting"
    /\ screen' = "startFailed"
    /\ UNCHANGED <<rooms, presses>>

JoinSucceeds ==
    /\ screen = "joining"
    /\ screen' = "live"
    /\ UNCHANGED <<rooms, presses>>

JoinFails ==
    /\ screen = "joining"
    /\ screen' = "joinFailed"
    /\ UNCHANGED <<rooms, presses>>

PressJoinAgain ==
    /\ screen = "joinFailed"
    /\ screen' = "joining"
    /\ UNCHANGED <<rooms, presses>>

Done ==
    /\ \/ screen = "live"
       \/ (screen = "startFailed" /\ presses = MaxPresses)
    /\ UNCHANGED vars

Next ==
    \/ PressStart \/ RoomMade \/ ResponseLost \/ RequestRejected
    \/ JoinSucceeds \/ JoinFails \/ PressJoinAgain \/ Done

Spec == Init /\ [][Next]_vars

\* One press of Start call, retried after a failure, still means one call.
OneCallPerPerson == rooms <= 1

\* The person who starts a call can end it for everyone.
StarterCanEndCall == screen = "live" => StarterCanEnd
=============================================================================
