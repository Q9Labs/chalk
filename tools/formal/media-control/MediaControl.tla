------------------------- MODULE MediaControl -------------------------
(***************************************************************************)
(* Media on/off between one DEVICE, SYNC (the room authority) and an SFU.  *)
(*                                                                         *)
(* The decided rule: turning media off is the device's decision and never  *)
(* fails; turning media on waits for Sync; after a reconnect the device    *)
(* resends its offs and takes every on from Sync.                          *)
(*                                                                         *)
(* One boolean per source: TRUE is on. Sources are mic, camera and screen  *)
(* share; they interact only through shared links and budgets.             *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
  Sources,        \* set of model values, e.g. {mic, cam, scr}
  MaxSeq,         \* user actions per source (device intent counter)
  MaxDrops,       \* Sync-link drops plus SFU-session drops
  MaxLoss,        \* messages the network may lose in total
  MaxHostMutes,   \* host mutes Sync may impose in total
  MaxCloseFails,  \* failed SFU close calls in total (only if CloseCanFail)
  ReconnectRule,  \* "decided" | "current" | "adoptSync" (deliberately broken)
  OptimisticUi,   \* TRUE = deliberately broken: UI shows on before Sync does
  CloseCanFail, OrphansLinger, AtomicRevoke  \* the SFU, see Sfu.tla

ASSUME ReconnectRule \in {"decided", "current", "adoptSync"}

Sfu == INSTANCE Sfu

\* Sources are interchangeable. Used for safety runs only: symmetry is unsound for liveness.
SourceSymmetry == Permutations(Sources)

VARIABLES
  \* DEVICE (SDK media controller)
  want,         \* want[s]: device intent, TRUE = on
  seq,          \* seq[s]: revision of the device's latest intent
  cap,          \* cap[s]: track is capturing and unmuted
  offState,     \* offState[s]: "none" | "queued" | "sent" | "failed"
  viewVer, viewAck, viewGranted, viewShown, viewHm,  \* last Sync snapshot applied
  reconciled,   \* the device has run its reconnect step on this Sync connection
  \* GHOSTS (not in any implementation)
  intent,       \* intent[s]: what the user last asked for, never changed by recovery
  reconnected,  \* at least one reconnect has completed
  \* SYNC
  grant,        \* grant[s]: Sync allows s to publish
  lastSeq,      \* lastSeq[s]: highest device revision Sync has accepted
  hostMute,     \* hostMute[s]: a host mute is in force
  ver,          \* ver[s]: version of Sync's snapshot for s
  \* SFU (see Sfu.tla)
  pubs, sess, sfuUp,
  \* NETWORK
  onSlot, offSlot, snap, pubReq, syncUp,
  \* FAULT BUDGETS
  drops, loss, mutes, cfails

dev    == <<want, seq, cap, offState, viewVer, viewAck, viewGranted, viewShown, viewHm, reconciled>>
ghosts == <<intent, reconnected>>
syncv  == <<grant, lastSeq, hostMute>>
sfuv   == <<pubs, sess, sfuUp>>
net    == <<onSlot, offSlot, snap, pubReq, syncUp>>
budg   == <<drops, loss, mutes, cfails>>
vars   == <<dev, ghosts, ver, syncv, sfuv, net, budg>>

----------------------------------------------------------------------------
Shown(g, p, s) == g[s] /\ \E x \in p : x.src = s
Flow(s)        == cap[s] /\ sfuUp /\ Sfu!Pub(s, sess) \in pubs

SnapOf(g, l, h, p, s) == <<g[s], l[s], h[s], Shown(g, p, s)>>

Ui(s) ==
  IF want[s] /\ OptimisticUi THEN "on"
  ELSE IF ~want[s] THEN "off"
  ELSE IF viewAck[s] >= seq[s] /\ viewGranted[s] /\ viewShown[s] THEN "on"
  ELSE "pending"

OffRetryable == IF ReconnectRule = "current" THEN {"queued"} ELSE {"queued", "sent"}

\* Each channel keeps, per source, the latest message of each kind. Delivery never
\* removes it (so it can arrive again: duplication, and out of order against
\* newer messages); loss removes it. Receivers ignore anything not newer.
NoSnap == [ver |-> -1, ack |-> 0, granted |-> FALSE, shown |-> FALSE, hm |-> FALSE]

Init ==
  /\ want = [s \in Sources |-> FALSE] /\ seq = [s \in Sources |-> 0]
  /\ cap = [s \in Sources |-> FALSE] /\ offState = [s \in Sources |-> "none"]
  /\ viewVer = [s \in Sources |-> 0] /\ viewAck = [s \in Sources |-> 0]
  /\ viewGranted = [s \in Sources |-> FALSE] /\ viewShown = [s \in Sources |-> FALSE]
  /\ viewHm = [s \in Sources |-> FALSE] /\ reconciled = TRUE
  /\ intent = [s \in Sources |-> FALSE] /\ reconnected = FALSE
  /\ grant = [s \in Sources |-> FALSE] /\ lastSeq = [s \in Sources |-> 0]
  /\ hostMute = [s \in Sources |-> FALSE] /\ ver = [s \in Sources |-> 0]
  /\ pubs = {} /\ sess = 0 /\ sfuUp = TRUE
  /\ onSlot = [s \in Sources |-> 0] /\ offSlot = [s \in Sources |-> 0]
  /\ snap = [s \in Sources |-> NoSnap] /\ pubReq = [s \in Sources |-> -1] /\ syncUp = TRUE
  /\ drops = 0 /\ loss = 0 /\ mutes = 0 /\ cfails = 0

----------------------------------------------------------------------------
(* DEVICE *)

\* Turning on waits for Sync: the device captures, asks, and shows "pending".
UserOn(s) ==
  /\ syncUp /\ reconciled /\ ~want[s] /\ seq[s] < MaxSeq
  /\ want' = [want EXCEPT ![s] = TRUE]
  /\ seq' = [seq EXCEPT ![s] = @ + 1]
  /\ cap' = [cap EXCEPT ![s] = TRUE]
  /\ intent' = [intent EXCEPT ![s] = TRUE]
  /\ offState' = [offState EXCEPT ![s] = "none"]
  /\ onSlot' = [onSlot EXCEPT ![s] = seq[s] + 1]
  /\ UNCHANGED <<viewVer, viewAck, viewGranted, viewShown, viewHm, reconciled, reconnected,
                 syncv, sfuv, offSlot, snap, pubReq, syncUp, budg>>

\* Turning off is the device's decision: capture stops in this step, link or no link.
UserOff(s) ==
  /\ want[s] /\ seq[s] < MaxSeq
  /\ want' = [want EXCEPT ![s] = FALSE]
  /\ seq' = [seq EXCEPT ![s] = @ + 1]
  /\ cap' = [cap EXCEPT ![s] = FALSE]
  /\ intent' = [intent EXCEPT ![s] = FALSE]
  /\ IF syncUp /\ reconciled
       THEN /\ offState' = [offState EXCEPT ![s] = "sent"]
            /\ offSlot' = [offSlot EXCEPT ![s] = seq[s] + 1]
       ELSE /\ offState' = [offState EXCEPT ![s] = "queued"]
            /\ offSlot' = offSlot
  /\ UNCHANGED <<viewVer, viewAck, viewGranted, viewShown, viewHm, reconciled, reconnected,
                 syncv, sfuv, onSlot, snap, pubReq, syncUp, budg>>

\* The device resends an unacknowledged on.
DeviceSendOn(s) ==
  /\ syncUp /\ reconciled /\ want[s] /\ viewAck[s] < seq[s]
  /\ onSlot' = [onSlot EXCEPT ![s] = seq[s]]
  /\ UNCHANGED <<dev, ghosts, syncv, sfuv, offSlot, snap, pubReq, syncUp, budg>>

\* The device resends an off Sync has not acknowledged. "current" resends only
\* an off queued while offline; a "failed" off is skipped.
DeviceSendOff(s) ==
  /\ syncUp /\ reconciled /\ ~want[s] /\ offState[s] \in OffRetryable
  /\ offState' = [offState EXCEPT ![s] = "sent"]
  /\ offSlot' = [offSlot EXCEPT ![s] = seq[s]]
  /\ UNCHANGED <<want, seq, cap, viewVer, viewAck, viewGranted, viewShown, viewHm, reconciled,
                 ghosts, syncv, sfuv, onSlot, snap, pubReq, syncUp, budg>>

\* Current SDK only: the off command times out and is recorded as failed.
OffTimeout(s) ==
  /\ ReconnectRule = "current" /\ syncUp /\ offState[s] = "sent"
  /\ offState' = [offState EXCEPT ![s] = "failed"]
  /\ UNCHANGED <<want, seq, cap, viewVer, viewAck, viewGranted, viewShown, viewHm, reconciled,
                 ghosts, syncv, sfuv, net, budg>>

\* The device asks the SFU to publish once Sync has granted this revision.
DevicePublish(s) ==
  /\ sfuUp /\ want[s] /\ cap[s] /\ viewGranted[s] /\ viewAck[s] >= seq[s]
  /\ pubReq' = [pubReq EXCEPT ![s] = sess]
  /\ UNCHANGED <<dev, ghosts, syncv, sfuv, onSlot, offSlot, snap, syncUp, budg>>

\* The device applies a Sync snapshot. Older or repeated snapshots are ignored.
DeviceRecvSnap ==
  \E s \in Sources :
    LET m == snap[s]
        acked == m.ack >= seq[s]
        moderated == want[s] /\ acked /\ ~m.granted
        adopt == ReconnectRule = "adoptSync" /\ ~want[s] /\ m.granted /\ m.shown /\ ~acked
    IN /\ syncUp /\ m.ver > viewVer[s]
       /\ viewVer' = [viewVer EXCEPT ![s] = m.ver]
       /\ viewAck' = [viewAck EXCEPT ![s] = m.ack]
       /\ viewGranted' = [viewGranted EXCEPT ![s] = m.granted]
       /\ viewShown' = [viewShown EXCEPT ![s] = m.shown]
       /\ viewHm' = [viewHm EXCEPT ![s] = m.hm]
       /\ want' = [want EXCEPT ![s] = IF moderated THEN FALSE ELSE IF adopt THEN TRUE ELSE @]
       /\ cap' = [cap EXCEPT ![s] = IF moderated THEN FALSE ELSE IF adopt THEN TRUE ELSE @]
       /\ offState' = [offState EXCEPT ![s] = IF acked \/ adopt THEN "none" ELSE @]
       /\ UNCHANGED <<seq, reconciled, ghosts, syncv, sfuv, net, budg>>

----------------------------------------------------------------------------
(* SYNC *)

SyncRecvOn ==
  \E s \in Sources :
    /\ syncUp /\ onSlot[s] > lastSeq[s]
    /\ lastSeq' = [lastSeq EXCEPT ![s] = onSlot[s]]
    /\ grant' = [grant EXCEPT ![s] = ~hostMute[s]]
    /\ UNCHANGED <<dev, ghosts, hostMute, sfuv, net, budg>>

\* Sync accepts every off, whatever the SFU does next.
SyncRecvOff ==
  \E s \in Sources :
    /\ syncUp /\ offSlot[s] > lastSeq[s]
    /\ lastSeq' = [lastSeq EXCEPT ![s] = offSlot[s]]
    /\ grant' = [grant EXCEPT ![s] = FALSE]
    /\ pubs' = Sfu!OnRevoke(pubs, s)
    /\ UNCHANGED <<dev, ghosts, hostMute, sess, sfuUp, net, budg>>

HostMute(s) ==
  /\ mutes < MaxHostMutes /\ ~hostMute[s]
  /\ hostMute' = [hostMute EXCEPT ![s] = TRUE]
  /\ grant' = [grant EXCEPT ![s] = FALSE]
  /\ pubs' = Sfu!OnRevoke(pubs, s)
  /\ mutes' = mutes + 1
  /\ UNCHANGED <<dev, ghosts, lastSeq, sess, sfuUp, net, drops, loss, cfails>>

HostLift(s) ==
  /\ hostMute[s]
  /\ hostMute' = [hostMute EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<dev, ghosts, grant, lastSeq, sfuv, net, budg>>

\* Sync sends its current snapshot (on change, on connect, and periodically).
SyncSnap(s) ==
  /\ syncUp
  /\ snap' = [snap EXCEPT ![s] = [ver |-> ver[s], ack |-> lastSeq[s], granted |-> grant[s],
                                  shown |-> Shown(grant, pubs, s), hm |-> hostMute[s]]]
  /\ UNCHANGED <<dev, ghosts, syncv, sfuv, onSlot, offSlot, pubReq, syncUp, budg>>

----------------------------------------------------------------------------
(* SFU, through Sfu.tla *)

\* The ledger admits a publication only if Sync's grant is on at that moment.
SfuAdmit ==
  \E s \in Sources :
    /\ sfuUp /\ pubReq[s] = sess /\ grant[s]
    /\ Sfu!Pub(s, sess) \notin pubs
    /\ pubs' = Sfu!Admit(pubs, s, sess)
    /\ UNCHANGED <<dev, ghosts, grant, lastSeq, hostMute, sess, sfuUp, net, budg>>

\* Sync closes a publication whose grant is off with a separate call.
SyncCloseOk ==
  \E p \in Sfu!Closable(pubs, grant) :
    /\ pubs' = pubs \ {p}
    /\ UNCHANGED <<dev, ghosts, grant, lastSeq, hostMute, sess, sfuUp, net, budg>>

SyncCloseFail ==
  /\ CloseCanFail /\ cfails < MaxCloseFails /\ Sfu!Closable(pubs, grant) # {}
  /\ cfails' = cfails + 1
  /\ UNCHANGED <<dev, ghosts, syncv, sfuv, net, drops, loss, mutes>>

SfuGc ==
  \E p \in Sfu!Collectable(pubs, sess, sfuUp) :
    /\ pubs' = pubs \ {p}
    /\ UNCHANGED <<dev, ghosts, grant, lastSeq, hostMute, sess, sfuUp, net, budg>>

----------------------------------------------------------------------------
(* NETWORK AND LINKS *)

DropSync ==
  /\ drops < MaxDrops /\ syncUp
  /\ syncUp' = FALSE
  /\ onSlot' = [s \in Sources |-> 0] /\ offSlot' = [s \in Sources |-> 0]
  /\ snap' = [s \in Sources |-> NoSnap]
  /\ reconciled' = FALSE
  /\ offState' = [s \in Sources |-> IF offState[s] = "sent" THEN "queued" ELSE offState[s]]
  /\ drops' = drops + 1
  /\ UNCHANGED <<want, seq, cap, viewVer, viewAck, viewGranted, viewShown, viewHm, ghosts,
                 syncv, sfuv, pubReq, loss, mutes, cfails>>

\* Reconnect: the device runs its recovery step (resends offs queued while away).
ReconnectSync ==
  /\ ~syncUp
  /\ syncUp' = TRUE /\ reconciled' = TRUE /\ reconnected' = TRUE
  /\ offState' = [s \in Sources |-> IF offState[s] = "queued" THEN "sent" ELSE offState[s]]
  /\ offSlot' = [s \in Sources |-> IF offState[s] = "queued" THEN seq[s] ELSE offSlot[s]]
  /\ UNCHANGED <<want, seq, cap, viewVer, viewAck, viewGranted, viewShown, viewHm, intent,
                 syncv, sfuv, onSlot, snap, pubReq, budg>>

DropSfu ==
  /\ drops < MaxDrops /\ sfuUp
  /\ sfuUp' = FALSE /\ pubReq' = [s \in Sources |-> -1]
  /\ pubs' = Sfu!OnSessionLost(pubs)
  /\ drops' = drops + 1
  /\ UNCHANGED <<dev, ghosts, grant, lastSeq, hostMute, sess, onSlot, offSlot, snap, syncUp, loss, mutes, cfails>>

\* A reconnect that rebuilds the SFU session: a new session id.
RebuildSfu ==
  /\ ~sfuUp
  /\ sfuUp' = TRUE /\ sess' = sess + 1
  /\ UNCHANGED <<dev, ghosts, syncv, pubs, net, budg>>

\* The network loses the latest message of one kind on one channel.
Lose(s) ==
  /\ loss < MaxLoss
  /\ \/ onSlot[s] > 0 /\ onSlot' = [onSlot EXCEPT ![s] = 0] /\ UNCHANGED <<offSlot, snap, pubReq>>
     \/ offSlot[s] > 0 /\ offSlot' = [offSlot EXCEPT ![s] = 0] /\ UNCHANGED <<onSlot, snap, pubReq>>
     \/ snap[s].ver >= 0 /\ snap' = [snap EXCEPT ![s] = NoSnap] /\ UNCHANGED <<onSlot, offSlot, pubReq>>
     \/ pubReq[s] >= 0 /\ pubReq' = [pubReq EXCEPT ![s] = -1] /\ UNCHANGED <<onSlot, offSlot, snap>>
  /\ loss' = loss + 1
  /\ UNCHANGED <<dev, ghosts, syncv, sfuv, syncUp, drops, mutes, cfails>>

----------------------------------------------------------------------------
\* Every Sync-side change to a source's snapshot gets a new version.
Stamp ==
  /\ ver' = [s \in Sources |->
       IF SnapOf(grant', lastSeq', hostMute', pubs', s) # SnapOf(grant, lastSeq, hostMute, pubs, s)
         THEN ver[s] + 1 ELSE ver[s]]

\* One action per line: trace-diff.mjs names a counterexample step by this text.
Next ==
  \/ \E s \in Sources : UserOn(s) /\ Stamp
  \/ \E s \in Sources : UserOff(s) /\ Stamp
  \/ \E s \in Sources : DeviceSendOn(s) /\ Stamp
  \/ \E s \in Sources : DeviceSendOff(s) /\ Stamp
  \/ \E s \in Sources : OffTimeout(s) /\ Stamp
  \/ \E s \in Sources : DevicePublish(s) /\ Stamp
  \/ \E s \in Sources : HostMute(s) /\ Stamp
  \/ \E s \in Sources : HostLift(s) /\ Stamp
  \/ \E s \in Sources : SyncSnap(s) /\ Stamp
  \/ \E s \in Sources : Lose(s) /\ Stamp
  \/ DeviceRecvSnap /\ Stamp
  \/ SyncRecvOn /\ Stamp
  \/ SyncRecvOff /\ Stamp
  \/ SfuAdmit /\ Stamp
  \/ SyncCloseOk /\ Stamp
  \/ SyncCloseFail /\ Stamp
  \/ SfuGc /\ Stamp
  \/ DropSync /\ Stamp
  \/ ReconnectSync /\ Stamp
  \/ DropSfu /\ Stamp
  \/ RebuildSfu /\ Stamp

\* Faults (loss, drops, host mutes, user actions, timeouts) get no fairness:
\* they are bounded by budgets. Everything that repairs state does.
Fair(A) == WF_vars(A /\ Stamp)
Fairness ==
  /\ \A s \in Sources : Fair(DeviceSendOn(s)) /\ Fair(DeviceSendOff(s))
                        /\ Fair(DevicePublish(s)) /\ Fair(SyncSnap(s))
  /\ Fair(DeviceRecvSnap) /\ Fair(SyncRecvOn) /\ Fair(SyncRecvOff)
  /\ Fair(SfuAdmit) /\ Fair(SyncCloseOk) /\ Fair(SfuGc)
  /\ Fair(ReconnectSync) /\ Fair(RebuildSfu)

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* PROPERTIES *)

TypeOK ==
  /\ want \in [Sources -> BOOLEAN] /\ cap \in [Sources -> BOOLEAN]
  /\ offState \in [Sources -> {"none", "queued", "sent", "failed"}]
  /\ seq \in [Sources -> 0..MaxSeq] /\ lastSeq \in [Sources -> 0..MaxSeq]

\* 1. A muted source never publishes: it does not capture, and nothing
\*    flows to the SFU, in any state, including during and after a reconnect.
P1_MutedNeverPublishes ==
  \A s \in Sources : (cap[s] => intent[s]) /\ (Flow(s) => intent[s])

\* 2. An off is never lost across a reconnect: when the Sync link comes back,
\*    every off Sync has not accepted is still owed (queued or sent).
P2_OffSurvivesReconnect ==
  [][ (~syncUp /\ syncUp') =>
        \A s \in Sources : (~want'[s] /\ lastSeq'[s] < seq'[s]) => offState'[s] \in {"queued", "sent"}
    ]_vars

\* 3. The UI never shows on before Sync does: it shows on only from a Sync
\*    snapshot that shows the source on for the device's latest revision.
P3_UiNotAhead ==
  \A s \in Sources :
    Ui(s) = "on" => (viewShown[s] /\ viewGranted[s] /\ viewAck[s] >= seq[s])

\* 4. Device and Sync agree again after faults: once the faults stop and
\*    delivery is fair, every source ends in agreement.
Agree(s) ==
  /\ viewVer[s] = ver[s]
  /\ IF want[s]
       THEN grant[s] /\ Sfu!Pub(s, sess) \in pubs /\ Ui(s) = "on"
       ELSE lastSeq[s] >= seq[s] /\ ~grant[s] /\ ~(\E p \in pubs : p.src = s)

P4_Converges == <>[](syncUp /\ sfuUp /\ \A s \in Sources : Agree(s))

----------------------------------------------------------------------------
(* WITNESSES. Each is expected to be VIOLATED: the violation is the proof that *)
(* the state is reachable, so the properties above are not vacuous.             *)

\* Turning on works end to end: the UI shows on and media flows to the SFU.
W1_OnReachable == \A s \in Sources : ~(Ui(s) = "on" /\ Flow(s))

\* A host mute reaches the device: it stops capturing although the user never turned off.
W2_HostMuteReachesDevice == \A s \in Sources : ~(intent[s] /\ ~want[s] /\ ~cap[s] /\ hostMute[s])
=======================================================================
