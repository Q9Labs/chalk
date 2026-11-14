---------------------------- MODULE StartClass ----------------------------
(***************************************************************************)
(* A person opens chalk.live, presses "Start call", and ends up in a call. *)
(*                                                                         *)
(* Code: apps/web/src/components/space/SpacePage.tsx (start, arrive),      *)
(* apps/web/src/lib/chalk-access.ts (createPublicSpace keeps one request   *)
(* key until a Start call succeeds), apps/api/internal/publicinvites/      *)
(* service.go (CreatePublicSpace: the same key gives the same Space, and   *)
(* the starter joins as "owner"), apps/api/db/queries/spaces.sql (the      *)
(* capabilities of that role).                                             *)
(*                                                                         *)
(* StarterCanEnd is the capability "endEpisode" of the starter's role. The *)
(* real value is TRUE: the starter is the "owner". FALSE is the old        *)
(* "collaborator" role, which has no host powers.                          *)
(* ReuseKey is TRUE when a retried press sends the key of the first press. *)
(* The real value is TRUE. FALSE is the old code, which made a new key on  *)
(* every press. StartClass.broken.cfg runs both old values.                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    MaxPresses,    \* how many times the person may press Start call
    StarterCanEnd, \* does the role the starter joins with include endEpisode?
    ReuseKey       \* does a retried press send the request key of the first press?

VARIABLES
    screen,   \* what the person sees
    rooms,    \* calls (Spaces) that now exist because of this person
    presses,  \* Start call presses so far
    keyRoom   \* the request key now held already made a call

vars == <<screen, rooms, presses, keyRoom>>

Screens == {"home", "starting", "joining", "live", "startFailed", "joinFailed"}

TypeOK ==
    /\ screen \in Screens
    /\ rooms \in 0..MaxPresses
    /\ presses \in 0..MaxPresses
    /\ keyRoom \in BOOLEAN

Init == screen = "home" /\ rooms = 0 /\ presses = 0 /\ keyRoom = FALSE

PressStart ==
    /\ screen \in {"home", "startFailed"}
    /\ presses < MaxPresses
    /\ screen' = "starting"
    /\ presses' = presses + 1
    /\ keyRoom' = (keyRoom /\ ReuseKey)
    /\ UNCHANGED rooms

RoomMade ==
    /\ screen = "starting"
    /\ screen' = "joining"
    /\ rooms' = IF keyRoom THEN rooms ELSE rooms + 1
    /\ keyRoom' = TRUE
    /\ UNCHANGED presses

ResponseLost ==
    /\ screen = "starting"
    /\ screen' = "startFailed"
    /\ rooms' = IF keyRoom THEN rooms ELSE rooms + 1
    /\ keyRoom' = TRUE
    /\ UNCHANGED presses

RequestRejected ==
    /\ screen = "starting"
    /\ screen' = "startFailed"
    /\ UNCHANGED <<rooms, presses, keyRoom>>

JoinSucceeds ==
    /\ screen = "joining"
    /\ screen' = "live"
    /\ UNCHANGED <<rooms, presses, keyRoom>>

JoinFails ==
    /\ screen = "joining"
    /\ screen' = "joinFailed"
    /\ UNCHANGED <<rooms, presses, keyRoom>>

PressJoinAgain ==
    /\ screen = "joinFailed"
    /\ screen' = "joining"
    /\ UNCHANGED <<rooms, presses, keyRoom>>

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
