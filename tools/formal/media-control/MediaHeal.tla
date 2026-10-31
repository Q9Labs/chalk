------------------------------ MODULE MediaHeal ------------------------------
(***************************************************************************)
(* Does every listener eventually hear every publication that stays on?    *)
(*                                                                         *)
(* One PUBLISHER (a microphone), SYNC (owns the publication list and its   *)
(* versions), the API with the SFU (owns the Cloudflare ledger and calls),  *)
(* and LISTENERS. Two repair mechanisms are modelled and can be switched   *)
(* off one by one (the mutants):                                           *)
(*   a. the listener heal loop in the client: compare desired publications *)
(*      (enabled in the roster) with actual ones (pulled, packets rising); *)
(*      pull what is missing, drop and re-pull what is flat, reconnect the *)
(*      receive session when it is down;                                   *)
(*   b. the server dead-publication path: a failed pull makes the API ask  *)
(*      the SFU; if the track is gone, Sync marks the publication dead, and *)
(*      the publisher republishes under a new publication id.              *)
(* The publisher keeps the decided rules of MediaControl.tla in reduced    *)
(* form: off never fails, on waits for Sync, a reconnect resends offs and  *)
(* takes ons from Sync. It is restated here (one source, no host mute), not *)
(* instantiated from MediaControl.tla, which stays unchanged.              *)
(*                                                                         *)
(* Time is not modelled. One heal tick of the client is several actions    *)
(* here (backoff tick, flat tick, drop, pull); a "tick" counter stands for  *)
(* about 500 ms.                                                           *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS
  Listeners, Pub,         \* model values: the listeners, and the publisher's roster slot
  MaxGen,                 \* publications that can ever be created (ids 1..MaxGen)
  MaxToggle,              \* user actions of the publisher
  MaxPubLost,             \* publisher track lost at the SFU, in total
  MaxListenerLost,        \* listener's pulled track lost, in total
  MaxPullFail,            \* pulls the SFU refuses or times out although the track exists
  MaxRecvDown,            \* listener receive-connection losses, in total
  MaxPubDrop,             \* publisher Sync-link drops, in total
  MaxSfuRebuild,          \* publisher SFU-session rebuilds, in total
  MaxLoss,                \* messages the network may lose, in total
  MaxHostMute,            \* Sync revokes the publisher's grant (a moderation pause), in total
  MaxFaults,              \* faults of all kinds together (keeps joint faults small)
  DeadThreshold,          \* failed pulls of one gone track before the API reports it dead
  CapTicks,               \* retry delay cap in heal ticks (about 1 s)
  FlatTicks,              \* flat observations before a pulled track is dropped (about 2 s)
  FailSat,                \* failure counter saturates here (keeps the state space finite)
  GiveUpAfter,            \* 0 = never give up; N = mutant: stop pulling after N failures
  RetryCap,               \* FALSE = mutant: retry delay doubles without a cap
  FlatDrop,               \* FALSE = mutant: a flat pulled track is never dropped and re-pulled
  RecvReconnect,          \* FALSE = mutant: a down receive connection is never rebuilt
  DeadPath,               \* FALSE = mutant: no server dead-publication path
  PublisherSelfDetect,    \* TRUE = publisher also notices its own lost track (#716 send-stall)
  MuteKeepsPublication,   \* TRUE = off keeps the publication (#716); FALSE = off retires it
  StaleLoss,              \* TRUE = a lost track may also linger at the SFU without packets
  RecoveryPause,          \* "item" = SDK today: after a reconnect pause the device if Sync's item for it is not enabled;
                          \* "grant" = proposed: pause only if Sync has seen this on-revision and its grant is off (moderation);
                          \* "none" = never pause on recovery
  LazyClose,              \* TRUE = retiring a publication leaves its track at the SFU until a separate close call
  SfuExpiresStale         \* TRUE = the SFU eventually expires a track that gets no packets (Cloudflare: 30 s)

\* Listeners are interchangeable. Used for safety runs only: symmetry is unsound for liveness.
ListenerSymmetry == Permutations(Listeners)

Gens == 1..MaxGen
Recipients == Listeners \cup {Pub}
Statuses == {"none", "on", "off", "dead"}

VARIABLES
  \* PUBLISHER (device)
  want, cap, seq, offSt, syncUp, onSlot, offSlot,
  pubGen,       \* publication the device believes it has (0 = none)
  pubReq,       \* a publish request is in flight to the API
  pubSfuUp,     \* the device's SFU session is up
  recovering,   \* -1, or the revision (seq) the device held on when its connection last dropped
  \* SYNC
  list,         \* list[g]: Sync's status of publication g
  grant, lastSeq, ver, nextGen,
  deadMsg,      \* publications the API told Sync are dead (in flight)
  \* SFU and API
  sfu,          \* publications the SFU still has
  stale,        \* subset of sfu: still there but no packets arrive
  obs,          \* obs[g]: failed pulls of g that the SFU confirmed gone
  \* ROSTER CHANNELS
  view, rmsg,
  \* LISTENERS
  recvUp, pulled, subLost, pair,
  \* FAULT BUDGETS
  bud

pubv  == <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubGen, pubReq, pubSfuUp, recovering>>
syncv == <<list, grant, lastSeq, nextGen, deadMsg>>
sfuv  == <<sfu, stale, obs>>
chan  == <<view, rmsg>>
lsv   == <<recvUp, pulled, subLost, pair>>
vars  == <<pubv, syncv, ver, sfuv, chan, lsv, bud>>

----------------------------------------------------------------------------
Min(a, b) == IF a < b THEN a ELSE b

FaultsLeft == bud.pl + bud.ll + bud.pf + bud.rd + bud.pd + bud.sr + bud.loss + bud.hm < MaxFaults

NoSnap == [ver |-> -1, list |-> [g \in Gens |-> "none"], grant |-> FALSE, ack |-> 0]
SyncSnapshot == [ver |-> ver, list |-> list, grant |-> grant, ack |-> lastSeq]

Desired(l) == {g \in Gens : view[l].list[g] = "on"}
Rising(l, g) == recvUp[l] /\ g \in pulled[l] /\ g \notin subLost[l] /\ g \in sfu /\ g \notin stale
Backoff(f) == IF RetryCap THEN Min(2 ^ (f - 1), CapTicks) ELSE 2 ^ (f - 1)
GaveUp(l, g) == GiveUpAfter > 0 /\ pair[l][g].fails >= GiveUpAfter
Olds(g) == {h \in Gens : h # g /\ list[h] = "on"}

FreshPair == [wait |-> 0, fails |-> 0, flat |-> 0]

\* #rememberRecoveryIntents: when the connection drops while on, remember the revision once.
Remember == IF recovering >= 0 THEN recovering ELSE IF want THEN seq ELSE -1

\* The participant's own item in a Sync snapshot: enabled only with a live publication (episode.ex:238).
ItemEnabled(m) == m.grant /\ \E g \in Gens : m.list[g] = "on"
PauseNeeded(m) ==
  CASE RecoveryPause = "item" -> ~ItemEnabled(m)
    [] RecoveryPause = "grant" -> ~m.grant /\ m.ack >= seq
    [] OTHER -> FALSE

Init ==
  /\ want = FALSE /\ cap = FALSE /\ seq = 0 /\ offSt = "none" /\ syncUp = TRUE
  /\ onSlot = 0 /\ offSlot = 0 /\ pubGen = 0 /\ pubReq = FALSE /\ pubSfuUp = TRUE /\ recovering = -1
  /\ list = [g \in Gens |-> "none"] /\ grant = FALSE /\ lastSeq = 0 /\ ver = 0 /\ nextGen = 1
  /\ deadMsg = {}
  /\ sfu = {} /\ stale = {} /\ obs = [g \in Gens |-> 0]
  /\ view = [r \in Recipients |-> [NoSnap EXCEPT !.ver = 0]]
  /\ rmsg = [r \in Recipients |-> NoSnap]
  /\ recvUp = [l \in Listeners |-> TRUE] /\ pulled = [l \in Listeners |-> {}]
  /\ subLost = [l \in Listeners |-> {}]
  /\ pair = [l \in Listeners |-> [g \in Gens |-> FreshPair]]
  /\ bud = [pl |-> 0, ll |-> 0, pf |-> 0, rd |-> 0, pd |-> 0, sr |-> 0, loss |-> 0, hm |-> 0]

----------------------------------------------------------------------------
(* PUBLISHER *)

UserOn ==
  /\ syncUp /\ ~want /\ seq < MaxToggle
  /\ want' = TRUE /\ cap' = TRUE /\ seq' = seq + 1 /\ offSt' = "none"
  /\ onSlot' = seq + 1
  /\ UNCHANGED <<syncUp, offSlot, pubGen, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

\* Off is the device's decision: capture stops in this step, link or no link.
UserOff ==
  /\ want /\ seq < MaxToggle
  /\ want' = FALSE /\ cap' = FALSE /\ seq' = seq + 1
  /\ IF syncUp
       THEN offSt' = "sent" /\ offSlot' = seq + 1
       ELSE offSt' = "queued" /\ offSlot' = offSlot
  /\ pubGen' = IF MuteKeepsPublication THEN pubGen ELSE 0
  /\ UNCHANGED <<syncUp, onSlot, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

DeviceSendOn ==
  /\ syncUp /\ want /\ view[Pub].ack < seq /\ onSlot # seq
  /\ onSlot' = seq
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, offSlot, pubGen, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

DeviceSendOff ==
  /\ syncUp /\ ~want /\ offSt \in {"queued", "sent"}
  /\ \/ offSt = "queued" \/ offSlot # seq
  /\ offSt' = "sent" /\ offSlot' = seq
  /\ UNCHANGED <<want, cap, seq, syncUp, onSlot, pubGen, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

\* The device asks the API to publish once Sync has granted this revision and it holds no publication.
DevicePublish ==
  /\ pubSfuUp /\ want /\ cap /\ pubGen = 0 /\ ~pubReq
  /\ view[Pub].grant /\ view[Pub].ack >= seq
  /\ pubReq' = TRUE
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubGen, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

\* The publisher's roster shows its publication dead: drop it and publish again.
PublisherDropDead ==
  /\ pubGen # 0 /\ view[Pub].list[pubGen] = "dead"
  /\ pubGen' = 0
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

\* #716: the publisher's own stats show the SFU no longer serves its track.
PublisherSelfDetectLoss ==
  /\ PublisherSelfDetect /\ pubGen # 0 /\ (pubGen \notin sfu \/ pubGen \in stale)
  /\ pubGen' = 0
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

\* #pauseRecoveredIntents: on the first Sync snapshot after the connection returns, a device
\* that still holds its old on-revision pauses its capture if Sync does not show it as live.
\* Its desired state stays on, and nothing turns capture back on by itself.
PublisherRecover ==
  /\ recovering >= 0 /\ syncUp /\ pubSfuUp /\ rmsg[Pub].ver >= 0 /\ rmsg[Pub].ver >= view[Pub].ver
  /\ view' = [view EXCEPT ![Pub] = rmsg[Pub]]
  /\ recovering' = -1
  /\ cap' = IF want /\ seq = recovering /\ PauseNeeded(rmsg[Pub]) THEN FALSE ELSE cap
  /\ offSt' = IF rmsg[Pub].ack >= seq /\ ~want THEN "none" ELSE offSt
  /\ UNCHANGED <<want, seq, syncUp, onSlot, offSlot, pubGen, pubReq, pubSfuUp, syncv, sfuv, rmsg, lsv, bud>>

\* The device applies a Sync snapshot (any recipient). Older or repeated ones are ignored.
RecvSnap(r) ==
  /\ rmsg[r].ver > view[r].ver /\ (r = Pub => syncUp)
  /\ view' = [view EXCEPT ![r] = rmsg[r]]
  /\ offSt' = IF r = Pub /\ rmsg[r].ack >= seq /\ ~want THEN "none" ELSE offSt
  /\ cap' = IF r = Pub /\ want /\ ~rmsg[r].grant /\ rmsg[r].ack >= seq THEN FALSE ELSE cap
  /\ UNCHANGED <<want, seq, syncUp, onSlot, offSlot, pubGen, pubReq, pubSfuUp, recovering, syncv, sfuv, rmsg, lsv, bud>>

----------------------------------------------------------------------------
(* SYNC AND API *)

SyncRecvOn ==
  /\ syncUp /\ onSlot > lastSeq
  /\ lastSeq' = onSlot /\ grant' = TRUE
  /\ UNCHANGED <<pubv, list, nextGen, deadMsg, sfuv, chan, lsv, bud>>

\* Sync accepts every off. Without MuteKeepsPublication the off also retires the publication.
SyncRecvOff ==
  /\ syncUp /\ offSlot > lastSeq
  /\ lastSeq' = offSlot /\ grant' = FALSE
  /\ IF MuteKeepsPublication
       THEN list' = list /\ sfu' = sfu /\ stale' = stale
       ELSE /\ list' = [g \in Gens |-> IF list[g] = "on" THEN "off" ELSE list[g]]
            /\ sfu' = IF LazyClose THEN sfu ELSE sfu \ {g \in Gens : list[g] = "on"}
            /\ stale' = IF LazyClose THEN stale ELSE stale \ {g \in Gens : list[g] = "on"}
  /\ UNCHANGED <<pubv, nextGen, deadMsg, obs, chan, lsv, bud>>

\* The API admits a publication only if Sync's grant is on, and a new one replaces the old.
Admit ==
  /\ pubReq /\ pubSfuUp /\ grant /\ pubGen = 0 /\ nextGen <= MaxGen
  /\ LET g == nextGen IN
       /\ list' = [h \in Gens |-> IF h = g THEN "on" ELSE IF list[h] = "on" THEN "off" ELSE list[h]]
       /\ sfu' = IF LazyClose THEN sfu \cup {g} ELSE (sfu \ Olds(g)) \cup {g}
       /\ stale' = IF LazyClose THEN stale ELSE stale \ Olds(g)
       /\ pubGen' = g /\ nextGen' = g + 1
  /\ pubReq' = FALSE
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubSfuUp, recovering, lastSeq, grant, deadMsg, obs, chan, lsv, bud>>

\* A host mute: Sync revokes the grant of an on-revision it has seen. The publication stays listed.
HostMute ==
  /\ bud.hm < MaxHostMute /\ FaultsLeft /\ grant /\ lastSeq >= 1
  /\ grant' = FALSE
  /\ bud' = [bud EXCEPT !.hm = @ + 1]
  /\ UNCHANGED <<pubv, list, lastSeq, nextGen, deadMsg, sfuv, chan, lsv>>

SyncSend(r) ==
  /\ (r = Pub => syncUp) /\ rmsg[r] # SyncSnapshot
  /\ rmsg' = [rmsg EXCEPT ![r] = SyncSnapshot]
  /\ UNCHANGED <<pubv, syncv, sfuv, view, lsv, bud>>

\* Sync applies the API's dead report. Only a publication it still lists as on can die.
SyncRecvDead(g) ==
  /\ g \in deadMsg
  /\ list' = [list EXCEPT ![g] = IF @ = "on" THEN "dead" ELSE @]
  /\ deadMsg' = deadMsg \ {g}
  /\ UNCHANGED <<pubv, grant, lastSeq, nextGen, sfuv, chan, lsv, bud>>

----------------------------------------------------------------------------
(* LISTENER HEAL LOOP *)

\* The receive session is rebuilt. Retry state does not survive it.
HealReconnect(l) ==
  /\ RecvReconnect /\ ~recvUp[l]
  /\ recvUp' = [recvUp EXCEPT ![l] = TRUE]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, pulled, subLost, pair, bud>>

\* A pulled track that the roster no longer lists as on is dropped.
HealDropUndesired(l, g) ==
  /\ recvUp[l] /\ g \in pulled[l] /\ g \notin Desired(l)
  /\ pulled' = [pulled EXCEPT ![l] = @ \ {g}]
  /\ subLost' = [subLost EXCEPT ![l] = @ \ {g}]
  /\ pair' = [pair EXCEPT ![l][g] = FreshPair]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, bud>>

PullReady(l, g) ==
  /\ recvUp[l] /\ g \in Desired(l) /\ g \notin pulled[l]
  /\ ~GaveUp(l, g) /\ pair[l][g].wait = 0

HealPullOk(l, g) ==
  /\ PullReady(l, g) /\ g \in sfu
  /\ pulled' = [pulled EXCEPT ![l] = @ \cup {g}]
  /\ subLost' = [subLost EXCEPT ![l] = @ \ {g}]
  /\ pair' = [pair EXCEPT ![l][g] = FreshPair]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, bud>>

\* The SFU does not have the track. The API asks the SFU, sees it gone, and after
\* DeadThreshold such failures reports the publication dead to Sync.
HealPullGone(l, g) ==
  /\ PullReady(l, g) /\ g \notin sfu
  /\ pair' = [pair EXCEPT ![l][g] = [wait |-> Backoff(Min(@.fails + 1, FailSat)),
                                      fails |-> Min(@.fails + 1, FailSat), flat |-> 0]]
  /\ IF DeadPath
       THEN /\ obs' = [obs EXCEPT ![g] = Min(@ + 1, DeadThreshold)]
            /\ deadMsg' = IF obs[g] + 1 >= DeadThreshold THEN deadMsg \cup {g} ELSE deadMsg
       ELSE obs' = obs /\ deadMsg' = deadMsg
  /\ UNCHANGED <<pubv, list, grant, lastSeq, nextGen, sfu, stale, chan, recvUp, pulled, subLost, bud>>

\* Fault: the SFU refuses or times out a pull although the track exists. The API
\* asks the SFU, finds the track, and records nothing.
HealPullRefused(l, g) ==
  /\ PullReady(l, g) /\ g \in sfu /\ bud.pf < MaxPullFail /\ FaultsLeft
  /\ pair' = [pair EXCEPT ![l][g] = [wait |-> Backoff(Min(@.fails + 1, FailSat)),
                                      fails |-> Min(@.fails + 1, FailSat), flat |-> 0]]
  /\ bud' = [bud EXCEPT !.pf = @ + 1]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, pulled, subLost>>

HealBackoffTick(l, g) ==
  /\ pair[l][g].wait > 0
  /\ pair' = [pair EXCEPT ![l][g].wait = @ - 1]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, pulled, subLost, bud>>

\* The stats sampler: one more flat sample, or packets rising again.
HealFlatTick(l, g) ==
  /\ recvUp[l] /\ g \in pulled[l]
  /\ \/ ~Rising(l, g) /\ pair[l][g].flat < FlatTicks /\ pair' = [pair EXCEPT ![l][g].flat = @ + 1]
     \/ Rising(l, g) /\ pair[l][g].flat > 0 /\ pair' = [pair EXCEPT ![l][g].flat = 0]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, pulled, subLost, bud>>

HealFlatDrop(l, g) ==
  /\ FlatDrop /\ recvUp[l] /\ g \in pulled[l] /\ pair[l][g].flat >= FlatTicks
  /\ pulled' = [pulled EXCEPT ![l] = @ \ {g}]
  /\ subLost' = [subLost EXCEPT ![l] = @ \ {g}]
  /\ pair' = [pair EXCEPT ![l][g] = FreshPair]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, bud>>

----------------------------------------------------------------------------
(* SFU *)

\* Cloudflare expires a track that gets no packets.
SfuGc(g) ==
  /\ SfuExpiresStale /\ g \in stale
  /\ sfu' = sfu \ {g} /\ stale' = stale \ {g}
  /\ UNCHANGED <<pubv, syncv, obs, chan, lsv, bud>>

\* The API closes the SFU track of a publication Sync no longer lists as on.
SfuClose(g) ==
  /\ LazyClose /\ g \in sfu /\ list[g] \in {"off", "dead"}
  /\ sfu' = sfu \ {g} /\ stale' = stale \ {g}
  /\ UNCHANGED <<pubv, syncv, obs, chan, lsv, bud>>

RebuildSfu ==
  /\ ~pubSfuUp
  /\ pubSfuUp' = TRUE
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, pubGen, pubReq, recovering, syncv, sfuv, chan, lsv, bud>>

ReconnectPub ==
  /\ ~syncUp
  /\ syncUp' = TRUE
  /\ offSt' = IF offSt = "queued" THEN "sent" ELSE offSt
  /\ offSlot' = IF offSt = "queued" THEN seq ELSE offSlot
  /\ UNCHANGED <<want, cap, seq, onSlot, pubGen, pubReq, pubSfuUp, recovering, syncv, sfuv, chan, lsv, bud>>

----------------------------------------------------------------------------
(* FAULTS. Each has a budget and no fairness. *)

\* The SFU forgets a track (or keeps it without packets) while Sync still lists it on.
PubTrackLost(g) ==
  /\ bud.pl < MaxPubLost /\ FaultsLeft /\ g \in sfu /\ g \notin stale /\ list[g] = "on"
  /\ \/ sfu' = sfu \ {g} /\ stale' = stale
     \/ StaleLoss /\ stale' = stale \cup {g} /\ sfu' = sfu
  /\ bud' = [bud EXCEPT !.pl = @ + 1]
  /\ UNCHANGED <<pubv, syncv, obs, chan, lsv>>

\* The SFU drops a listener's subscription: the track stays pulled, packets go flat.
ListenerTrackLost(l, g) ==
  /\ bud.ll < MaxListenerLost /\ FaultsLeft /\ recvUp[l] /\ g \in pulled[l] /\ g \notin subLost[l]
  /\ subLost' = [subLost EXCEPT ![l] = @ \cup {g}]
  /\ bud' = [bud EXCEPT !.ll = @ + 1]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan, recvUp, pulled, pair>>

RecvDown(l) ==
  /\ bud.rd < MaxRecvDown /\ FaultsLeft /\ recvUp[l]
  /\ recvUp' = [recvUp EXCEPT ![l] = FALSE]
  /\ pulled' = [pulled EXCEPT ![l] = {}]
  /\ subLost' = [subLost EXCEPT ![l] = {}]
  /\ pair' = [pair EXCEPT ![l] = [g \in Gens |-> FreshPair]]
  /\ bud' = [bud EXCEPT !.rd = @ + 1]
  /\ UNCHANGED <<pubv, syncv, sfuv, chan>>

DropPub ==
  /\ bud.pd < MaxPubDrop /\ FaultsLeft /\ syncUp
  /\ syncUp' = FALSE
  /\ onSlot' = 0 /\ offSlot' = 0
  /\ offSt' = IF offSt = "sent" THEN "queued" ELSE offSt
  /\ recovering' = Remember
  /\ rmsg' = [rmsg EXCEPT ![Pub] = NoSnap]
  /\ bud' = [bud EXCEPT !.pd = @ + 1]
  /\ UNCHANGED <<want, cap, seq, pubGen, pubReq, pubSfuUp, syncv, sfuv, view, lsv>>

\* The publisher's SFU session dies and is rebuilt later: its tracks vanish or linger.
DropSfu ==
  /\ bud.sr < MaxSfuRebuild /\ FaultsLeft /\ pubSfuUp
  /\ pubSfuUp' = FALSE /\ pubGen' = 0 /\ pubReq' = FALSE /\ recovering' = Remember
  /\ \/ sfu' = {} /\ stale' = {}
     \/ StaleLoss /\ stale' = sfu /\ sfu' = sfu
  /\ bud' = [bud EXCEPT !.sr = @ + 1]
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, onSlot, offSlot, syncv, obs, chan, lsv>>

\* The network loses the latest message of one kind.
Lose ==
  /\ bud.loss < MaxLoss /\ FaultsLeft
  /\ \/ onSlot > 0 /\ onSlot' = 0 /\ UNCHANGED <<offSlot, pubReq, rmsg, deadMsg>>
     \/ offSlot > 0 /\ offSlot' = 0 /\ UNCHANGED <<onSlot, pubReq, rmsg, deadMsg>>
     \/ pubReq /\ pubReq' = FALSE /\ UNCHANGED <<onSlot, offSlot, rmsg, deadMsg>>
     \/ \E r \in Recipients : rmsg[r].ver >= 0 /\ rmsg' = [rmsg EXCEPT ![r] = NoSnap]
                              /\ UNCHANGED <<onSlot, offSlot, pubReq, deadMsg>>
     \/ \E g \in deadMsg : deadMsg' = deadMsg \ {g} /\ UNCHANGED <<onSlot, offSlot, pubReq, rmsg>>
  /\ bud' = [bud EXCEPT !.loss = @ + 1]
  /\ UNCHANGED <<want, cap, seq, offSt, syncUp, pubGen, pubSfuUp, recovering, list, grant, lastSeq, nextGen, sfuv, view, lsv>>

----------------------------------------------------------------------------
\* Every change to Sync's roster state gets a new version.
Stamp ==
  ver' = IF list' # list \/ grant' # grant \/ lastSeq' # lastSeq THEN ver + 1 ELSE ver

\* One action per line: trace-diff.mjs names a counterexample step by this text.
Next ==
  \/ UserOn /\ Stamp
  \/ UserOff /\ Stamp
  \/ DeviceSendOn /\ Stamp
  \/ DeviceSendOff /\ Stamp
  \/ DevicePublish /\ Stamp
  \/ PublisherDropDead /\ Stamp
  \/ PublisherSelfDetectLoss /\ Stamp
  \/ \E r \in Recipients : RecvSnap(r) /\ Stamp
  \/ PublisherRecover /\ Stamp
  \/ SyncRecvOn /\ Stamp
  \/ SyncRecvOff /\ Stamp
  \/ Admit /\ Stamp
  \/ HostMute /\ Stamp
  \/ \E r \in Recipients : SyncSend(r) /\ Stamp
  \/ \E g \in Gens : SyncRecvDead(g) /\ Stamp
  \/ \E l \in Listeners : HealReconnect(l) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealDropUndesired(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealPullOk(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealPullGone(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealPullRefused(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealBackoffTick(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealFlatTick(l, g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : HealFlatDrop(l, g) /\ Stamp
  \/ \E g \in Gens : SfuGc(g) /\ Stamp
  \/ \E g \in Gens : SfuClose(g) /\ Stamp
  \/ RebuildSfu /\ Stamp
  \/ ReconnectPub /\ Stamp
  \/ \E g \in Gens : PubTrackLost(g) /\ Stamp
  \/ \E l \in Listeners, g \in Gens : ListenerTrackLost(l, g) /\ Stamp
  \/ \E l \in Listeners : RecvDown(l) /\ Stamp
  \/ DropPub /\ Stamp
  \/ DropSfu /\ Stamp
  \/ Lose /\ Stamp

\* Fairness (weak): every repair step that stays enabled is eventually taken. That
\* covers the heal tick (its backoff, flat, drop and pull parts), the republish
\* steps, deliveries, resends, reconnects and garbage collection. Faults and user
\* actions get none; budgets bound them. No strong fairness is needed: a repair
\* step becomes enabled and stays enabled once the faults have stopped.
Fair(A) == WF_vars(A /\ Stamp)
Fairness ==
  /\ Fair(DeviceSendOn) /\ Fair(DeviceSendOff) /\ Fair(DevicePublish)
  /\ Fair(PublisherDropDead) /\ Fair(PublisherSelfDetectLoss) /\ Fair(PublisherRecover)
  /\ Fair(SyncRecvOn) /\ Fair(SyncRecvOff) /\ Fair(Admit)
  /\ Fair(RebuildSfu) /\ Fair(ReconnectPub)
  /\ \A r \in Recipients : Fair(RecvSnap(r)) /\ Fair(SyncSend(r))
  /\ \A g \in Gens : Fair(SyncRecvDead(g)) /\ Fair(SfuGc(g)) /\ Fair(SfuClose(g))
  /\ \A l \in Listeners : Fair(HealReconnect(l))
  /\ \A l \in Listeners, g \in Gens :
       Fair(HealDropUndesired(l, g)) /\ Fair(HealPullOk(l, g)) /\ Fair(HealPullGone(l, g))
       /\ Fair(HealBackoffTick(l, g)) /\ Fair(HealFlatTick(l, g)) /\ Fair(HealFlatDrop(l, g))

Spec == Init /\ [][Next]_vars /\ Fairness

----------------------------------------------------------------------------
(* PROPERTIES *)

TypeOK ==
  /\ want \in BOOLEAN /\ cap \in BOOLEAN /\ seq \in 0..MaxToggle /\ lastSeq \in 0..MaxToggle
  /\ offSt \in {"none", "queued", "sent"} /\ recovering \in -1..MaxToggle
  /\ list \in [Gens -> Statuses] /\ nextGen \in 1..(MaxGen + 1)
  /\ sfu \subseteq Gens /\ stale \subseteq sfu /\ deadMsg \subseteq Gens
  /\ \A l \in Listeners : pulled[l] \subseteq Gens /\ subLost[l] \subseteq pulled[l]

\* The publication supply never runs out before the budgets do, so a result is not a bound artifact.
GenSupply == ~(pubReq /\ grant /\ pubGen = 0 /\ pubSfuUp /\ nextGen > MaxGen)

\* P1. A muted publisher never captures. No heal or republish step turns capture on.
P1_MutedNeverCaptures == cap => want

\* P1b. Only the user turns capture on: no heal, republish or recovery step does.
P1b_OnlyUserCaptures == [][ (~cap /\ cap') => (~want /\ want') ]_vars

\* P1d. A host mute that Sync has applied stops capture, also when it arrives during a reconnect.
P1d_HostMuteStopsCapture == <>[](syncUp /\ want /\ ~grant /\ lastSeq >= seq => ~cap)

\* P2. An off is never lost across a publisher reconnect.
P2_OffSurvivesReconnect ==
  [][ (~syncUp /\ syncUp') => ((~want' /\ lastSeq' < seq') => offSt' \in {"queued", "sent"}) ]_vars

\* P4h. Faults stop, delivery is fair: publisher and Sync agree again.
P4h_PublisherAgrees ==
  <>[](syncUp /\ (want => grant) /\ (~want => (lastSeq >= seq /\ ~grant)))

\* S5. The heal loop pulls a publication only if its roster shows it on.
S5_PullOnlyListed ==
  [][ \A l \in Listeners, g \in Gens : (g \in pulled'[l] /\ g \notin pulled[l]) => view[l].list[g] = "on" ]_vars

\* S5b. Against Sync itself, not the listener's roster. Expected VIOLATED: the roster is stale.
S5b_PullOnlyIfSyncListsOn ==
  [][ \A l \in Listeners, g \in Gens : (g \in pulled'[l] /\ g \notin pulled[l]) => list[g] = "on" ]_vars

\* S5c. A pulled publication that Sync lists as off or dead is eventually dropped.
S5c_UndesiredDropped ==
  \A l \in Listeners, g \in Gens : <>[](list[g] \in {"off", "dead"} /\ recvUp[l] => g \notin pulled[l])

\* P6. Retry spacing stays within the cap, so a listener does not wait long between pulls.
P6_RetrySpacing == \A l \in Listeners, g \in Gens : pair[l][g].wait <= CapTicks

\* P5. Zero stuck silence: a publication that stays on while its publisher stays
\* connected is eventually pulled with packets rising, and stays so.
P5_EveryOnPublicationHeard ==
  \A l \in Listeners, g \in Gens :
    (<>[](list[g] = "on" /\ syncUp)) => <>[]Rising(l, g)

\* P5src. The same at the level of the user's intent, so that marking a publication
\* dead cannot satisfy P5 by making it vacuous: if the publisher keeps the microphone
\* on and stays connected, every listener eventually hears some live publication.
P5src_MicrophoneHeard ==
  \A l \in Listeners :
    (<>[](want /\ syncUp /\ bud.hm = 0)) => <>[](cap /\ \E g \in Gens : list[g] = "on" /\ Rising(l, g))

----------------------------------------------------------------------------
(* WITNESSES. Each is expected to be VIOLATED: the violation proves the state is reachable. *)

W1_Heard == \A l \in Listeners, g \in Gens : ~(want /\ cap /\ list[g] = "on" /\ Rising(l, g))
W2_DeadThenRepublished ==
  ~(\E g, h \in Gens : g < h /\ list[g] = "dead" /\ list[h] = "on" /\ \E l \in Listeners : Rising(l, h))
W3_FlatThenRepulled ==
  \A l \in Listeners, g \in Gens : ~(g \in pulled[l] /\ g \in subLost[l] /\ pair[l][g].flat >= FlatTicks)
\* The recovery pause: the device wants the microphone on but has stopped capture.
W4_PausedByRecovery == ~(want /\ ~cap)
W5_DeadWhileOffline == ~(want /\ ~syncUp /\ recovering >= 0 /\ \E g \in Gens : list[g] = "dead")
=======================================================================
