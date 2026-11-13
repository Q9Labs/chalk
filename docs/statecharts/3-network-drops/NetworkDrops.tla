---------------------------- MODULE NetworkDrops ----------------------------
(***************************************************************************)
(* A student is in a call. Their connection drops or their device freezes *)
(* (laptop lid closed, phone locked), then the connection comes back.      *)
(*                                                                         *)
(* Two clocks matter. The page's recovery clock gives up after 60 seconds *)
(* of trying while the page is awake. The server's seat clock removes the *)
(* student about 2 minutes after the last sign of life, awake or not.     *)
(*                                                                         *)
(* Code:                                                                   *)
(*  sdks/typescript/client/src/connection/lifecycle.ts                     *)
(*    recover (684), finishRecovery (801), settleTerminalSnapshot (967),   *)
(*    failForSnapshot (1065); MEDIA_RECOVERY_TIMEOUT_MS = 60000 (18)       *)
(*  sdks/typescript/client/src/sync/v1-client.ts:577-580                   *)
(*    the student's own participant_left becomes participant_inactive      *)
(*  settleTerminalSnapshot sets timedOut when that happens while the       *)
(*    student is still in the call; a pressed Leave never sets it          *)
(*  apps/api/internal/adapters/postgres/participant_presence.go            *)
(*    expireEpisodePresence (65): an expired seat gets the same            *)
(*    participant_leave operation as a pressed Leave                       *)
(*  apps/sync/lib/chalk_sync/episodes/reducer.ex:421                       *)
(*    the reason of participant_left defaults to "left"                    *)
(*  sdks/typescript/react/src/components/chalk/StatusSurface.tsx           *)
(*    the "You left" screen and the "timed-out" screen                     *)
(*  sdks/typescript/client/src/space-client/media-controller.ts            *)
(*    the owed off (offDebt), lines 49-62, 514, 600-613, 943               *)
(*                                                                         *)
(* ShowsTimeout is TRUE in the real code: a seat the server gave up shows  *)
(* the "timedOut" screen. FALSE is the old code, which showed "left".      *)
(* NetworkDrops.broken.cfg runs the old value.                             *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
    ShowsTimeout \* does a seat the server gave up show the timeout screen?

VARIABLES
    screen,       \* what the student sees
    seat,         \* the server still holds the student's seat: "held" or "gone"
    pressedLeave, \* the student pressed Leave
    micLocal,     \* the student's own microphone: "on" or "off"
    micOthers,    \* what the other people get from the student: "on" or "off"
    debt          \* the page still owes Sync an "off" for the microphone: "none" or "owed"

vars == <<screen, seat, pressedLeave, micLocal, micOthers, debt>>

Screens == {"live", "reconnecting", "lost", "frozen", "left", "timedOut"}

TypeOK ==
    /\ screen \in Screens
    /\ seat \in {"held", "gone"}
    /\ pressedLeave \in BOOLEAN
    /\ micLocal \in {"on", "off"}
    /\ micOthers \in {"on", "off"}
    /\ debt \in {"none", "owed"}

Init ==
    /\ screen = "live"
    /\ seat = "held"
    /\ pressedLeave = FALSE
    /\ micLocal = "on"
    /\ micOthers = "on"
    /\ debt = "none"

\* The page is awake and the connection fails: recovery starts.
ConnectionDrops ==
    /\ screen = "live"
    /\ screen' = "reconnecting"
    /\ UNCHANGED <<seat, pressedLeave, micLocal, micOthers, debt>>

\* The recovery budget of 60 seconds runs out while the page is awake.
RecoveryGivesUp ==
    /\ screen = "reconnecting"
    /\ screen' = "lost"
    /\ UNCHANGED <<seat, pressedLeave, micLocal, micOthers, debt>>

\* Sync and the media come back. The page may still owe an "off" for the microphone.
ConnectionReturns ==
    /\ screen = "reconnecting"
    /\ seat = "held"
    /\ screen' = "live"
    /\ UNCHANGED <<seat, pressedLeave, micLocal, micOthers, debt>>

PageFreezes ==
    /\ screen \in {"live", "reconnecting"}
    /\ screen' = "frozen"
    /\ UNCHANGED <<seat, pressedLeave, micLocal, micOthers, debt>>

\* The server removes the seat. It does not wait for the page.
SeatExpires ==
    /\ screen \in {"lost", "frozen"}
    /\ seat = "held"
    /\ seat' = "gone"
    /\ UNCHANGED <<screen, pressedLeave, micLocal, micOthers, debt>>

\* The page wakes and asks Sync for what it missed.
PageWakes ==
    /\ screen = "frozen"
    /\ screen' = IF seat = "held" THEN "reconnecting" ELSE IF ShowsTimeout THEN "timedOut" ELSE "left"
    /\ UNCHANGED <<seat, pressedLeave, micLocal, micOthers, debt>>

PressLeave ==
    /\ screen = "live"
    /\ screen' = "left"
    /\ pressedLeave' = TRUE
    /\ UNCHANGED <<seat, micLocal, micOthers, debt>>

\* Turning the microphone off always works on the device. Telling Sync is a debt.
PressMicOff ==
    /\ screen \in {"live", "reconnecting"}
    /\ micLocal = "on"
    /\ micLocal' = "off"
    /\ debt' = IF micOthers = "on" THEN "owed" ELSE debt
    /\ UNCHANGED <<screen, seat, pressedLeave, micOthers>>

\* Needs a live Sync connection, so only "live" can pay.
PayMuteDebt ==
    /\ screen = "live"
    /\ debt = "owed"
    /\ micOthers' = "off"
    /\ debt' = "none"
    /\ UNCHANGED <<screen, seat, pressedLeave, micLocal>>

Done == screen \in {"lost", "left", "timedOut"} /\ UNCHANGED vars

Next ==
    \/ ConnectionDrops \/ RecoveryGivesUp \/ ConnectionReturns
    \/ PageFreezes \/ SeatExpires \/ PageWakes \/ PressLeave
    \/ PressMicOff \/ PayMuteDebt \/ Done

Spec == Init /\ [][Next]_vars

\* The "You left" screen shows only to a student who pressed Leave.
LeftOnlyWhenYouLeave == screen = "left" => pressedLeave

\* A microphone the student turned off is never lost: until the others stop
\* getting audio, the page keeps the debt.
MuteIsNeverForgotten == (micLocal = "off" /\ micOthers = "on") => debt = "owed"
=============================================================================
