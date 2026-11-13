---------------------------- MODULE StudentJoins ----------------------------
(***************************************************************************)
(* A student opens an invite link and gets into a call, or does not.       *)
(* They may wait for the host to let them in, and they may reload the      *)
(* page while in the call.                                                 *)
(*                                                                         *)
(* Code:                                                                   *)
(*  apps/web/src/components/space/SpacePage.tsx   start, arrive, resume    *)
(*  apps/web/src/lib/chalk-access.ts              arrival calls            *)
(*  apps/api/internal/publicinvites/service.go    Arrive (943),            *)
(*    ArrivalStatus (1162), resolvePendingAdmission (1220),                *)
(*    pendingGuestArrivalValid (1291)                                      *)
(*  apps/api/internal/publicinviteapp/access.go   GrantPublicAccess (122)  *)
(*  sdks/typescript/client/src/space-client/reload-rejoin.ts               *)
(*    (the reload marker lives for 120 seconds)                            *)
(*                                                                         *)
(* mode is the admission mode the host set: "open" lets anyone in,         *)
(* "knock" makes a student wait for the host. The host's answer arrives    *)
(* the next time the student's page asks, so the model joins both steps.   *)
(***************************************************************************)
EXTENDS Naturals

VARIABLES
    screen,  \* what the student sees
    mode,    \* the room's admission mode: "open" or "knock"
    cause    \* why the waiting request ended without an answer from the host

vars == <<screen, mode, cause>>

Screens == {"link", "waiting", "joining", "live", "declined", "unavailable", "returning", "returnFailed", "dead"}
Causes == {"none", "opened", "timeout", "linkChanged"}

TypeOK ==
    /\ screen \in Screens
    /\ mode \in {"open", "knock"}
    /\ cause \in Causes

Init == screen = "link" /\ mode \in {"open", "knock"} /\ cause = "none"

PressJoin ==
    /\ screen = "link"
    /\ screen' = IF mode = "knock" THEN "waiting" ELSE "joining"
    /\ UNCHANGED <<mode, cause>>

HostLetsIn ==
    /\ screen = "waiting"
    /\ screen' = "joining"
    /\ UNCHANGED <<mode, cause>>

HostDeclines ==
    /\ screen = "waiting"
    /\ screen' = "declined"
    /\ UNCHANGED <<mode, cause>>

\* pendingGuestArrivalValid is false once admission is no longer "knock".
HostOpensRoom ==
    /\ screen = "waiting"
    /\ screen' = "unavailable"
    /\ mode' = "open"
    /\ cause' = "opened"

HostChangesLink ==
    /\ screen = "waiting"
    /\ screen' = "dead"
    /\ cause' = "linkChanged"
    /\ UNCHANGED mode

WaitTimesOut ==
    /\ screen = "waiting"
    /\ screen' = "unavailable"
    /\ cause' = "timeout"
    /\ UNCHANGED mode

PressJoinAgain ==
    /\ screen \in {"declined", "unavailable", "returnFailed"}
    /\ screen' = "link"
    /\ cause' = "none"
    /\ UNCHANGED mode

VideoConnects ==
    /\ screen = "joining"
    /\ screen' = "live"
    /\ UNCHANGED <<mode, cause>>

ConnectFails ==
    /\ screen = "joining"
    /\ screen' = "link"
    /\ UNCHANGED <<mode, cause>>

\* The marker is under 120 seconds old, so the page tries to return.
ReloadSoon ==
    /\ screen = "live"
    /\ screen' = "returning"
    /\ UNCHANGED <<mode, cause>>

ReloadLate ==
    /\ screen = "live"
    /\ screen' = "link"
    /\ UNCHANGED <<mode, cause>>

ReturnSucceeds ==
    /\ screen = "returning"
    /\ screen' = "live"
    /\ UNCHANGED <<mode, cause>>

\* Another tab or device holds the seat, so the saved media proof is refused.
ReturnRefused ==
    /\ screen = "returning"
    /\ screen' = "returnFailed"
    /\ UNCHANGED <<mode, cause>>

Done == screen \in {"dead"} /\ UNCHANGED vars

Next ==
    \/ PressJoin \/ HostLetsIn \/ HostDeclines \/ HostOpensRoom \/ HostChangesLink
    \/ WaitTimesOut \/ PressJoinAgain \/ VideoConnects \/ ConnectFails
    \/ ReloadSoon \/ ReloadLate \/ ReturnSucceeds \/ ReturnRefused \/ Done

Spec == Init /\ [][Next]_vars

\* A student who waits for the host is let in or declined by the host.
\* They are not turned away because the host made entry easier.
WaiterNotTurnedAwayWhenHostOpens == ~(screen = "unavailable" /\ cause = "opened")

=============================================================================
