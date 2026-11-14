---------------------------- MODULE ClientRecovery ----------------------------
\* The SDK's connection lifecycle: how one client joins, loses and regains Sync
\* and media, refreshes its access grant, and leaves. Every lifecycle step is
\* one item on the actor queue in sdks/typescript/client/src/connection/lifecycle.ts
\* (`enqueue`, `Queue.take`), so the model keeps that queue in order and takes
\* only its head. The recovery fiber (`recover`) and the refresh fiber
\* (`scheduleRefresh`) run beside the queue and talk to it by enqueueing items.
\* The names below are the code's: Model.state, Model.recoveryQueued, plan.kind.
EXTENDS Naturals, Sequences

CONSTANTS
    MaxEpoch,          \* joins the run may perform (model.epoch)
    MaxSyncFaults,     \* Sync drops
    MaxMediaFaults,    \* media drops
    MaxTerminal,       \* Sync terminal frames (episode_ended, participant_removed, ...)
    MaxRefreshFaults,  \* access refreshes that fail
    MaxLeaves,         \* Leave calls
    SyncMayDie,        \* TRUE lets Sync go down and never come back
    RqRule,            \* "syncWins" = a queued sync recovery is never downgraded (the code), "overwrite" = the newest kind wins (finding F1)
    LeaveRule,         \* "stops" = Leave ends the recovery first (the code), "keepsRunning" = it runs on while Leave waits (finding F2)
    GrantRule,         \* "failsOnExpiry" = a refresh that fails after the grant ran out fails the Connection (the code), "staysLive" = it retries for ever (finding F3)
    Break              \* "none", or a variant of the code that must break one rule

VARIABLES
    conn, epoch, busy, q,                       \* actor: model.state, model.epoch, work in flight, queue
    syncP, term, mediaP, syncDead,              \* the world: Sync client phase and terminal reason, media phase
    rq, fib, fibE, fibKind, pk, okS, okM,       \* recovery: recoveryQueued and the recovery fiber
    grant, rf,                                  \* access grant and refresh fiber
    sf, mf, tf, rfault, lvs,                    \* fault budgets spent
    leaveRan, endObserved, removalSeen, removedByHost, restartInLeave  \* history for the rules

coreV == <<conn, epoch, busy, q>>
worldV == <<syncP, term, mediaP, syncDead>>
recV == <<rq, fib, fibE, fibKind, pk, okS, okM>>
accV == <<grant, rf>>
budV == <<sf, mf, tf, rfault, lvs>>
histV == <<leaveRan, endObserved, removalSeen, removedByHost, restartInLeave>>
vars == <<coreV, worldV, recV, accV, budV, histV>>

ConnStates == {"idle", "joining", "live", "reconnecting", "leaving", "left", "failed"}
\* The code names the Sync phase after the token is fetched "recovering"; it is the authenticating step.
SyncPhases == {"connecting", "recovering", "live", "terminal", "stopped"}
Reasons == {"none", "episode_ended", "participant_removed", "access_rejected", "transient"}
MediaPhases == {"idle", "connecting", "live", "recovering", "failed"}
Kinds == {"none", "sync", "media"}
Stages == {"none", "grace", "waitRec", "loopHead", "attempt", "waitRest", "waitExh", "afterExh", "backoff"}
Grants == {"none", "fresh", "stale", "expired", "revoked"}
Refreshes == {"none", "sleep", "flight", "returning"}
Items == {"join", "leave", "snapS", "snapM", "fin", "fail", "exh", "rec", "rest", "refr"}

Active == conn \in {"live", "reconnecting"}   \* lifecycle.ts active()
Item(t, e, o) == [t |-> t, e |-> e, o |-> o]
Has(t) == \E i \in 1..Len(q) : q[i].t = t
PushSnap(base, t) == IF \E i \in 1..Len(base) : base[i].t = t THEN base ELSE Append(base, Item(t, 0, "none"))
Phase(k) == IF k = "sync" THEN syncP ELSE mediaP

TypeOK ==
    /\ conn \in ConnStates /\ epoch \in 0..MaxEpoch /\ busy \in {"none", "join", "leave"}
    /\ \A i \in 1..Len(q) : q[i].t \in Items
    /\ syncP \in SyncPhases /\ term \in Reasons /\ mediaP \in MediaPhases /\ syncDead \in BOOLEAN
    /\ rq \in Kinds /\ fib \in Stages /\ pk \in Kinds /\ fibKind \in Kinds /\ okS \in BOOLEAN /\ okM \in BOOLEAN
    /\ grant \in Grants /\ rf \in Refreshes

Init ==
    /\ conn = "idle" /\ epoch = 0 /\ busy = "none" /\ q = <<>>
    /\ syncP = "stopped" /\ term = "none" /\ mediaP = "idle" /\ syncDead = FALSE
    /\ rq = "none" /\ fib = "none" /\ fibE = 0 /\ fibKind = "none" /\ pk = "none" /\ okS = FALSE /\ okM = FALSE
    /\ grant = "none" /\ rf = "none"
    /\ sf = 0 /\ mf = 0 /\ tf = 0 /\ rfault = 0 /\ lvs = 0
    /\ leaveRan = FALSE /\ endObserved = FALSE /\ removalSeen = FALSE /\ removedByHost = FALSE /\ restartInLeave = FALSE

\* ---- Shared effects --------------------------------------------------------

FibIdle == /\ fib' = "none" /\ fibE' = 0 /\ fibKind' = "none" /\ pk' = "none" /\ okS' = FALSE /\ okM' = FALSE

\* stopPorts (lifecycle.ts:350): rq cleared, scope closed (kills the fibers), clients stopped, grant cleared.
StopPortsRq(r) ==
    /\ rq' = r /\ FibIdle
    /\ syncP' = "stopped" /\ term' = "none" /\ mediaP' = "idle" /\ syncDead' = FALSE
    /\ grant' = "none" /\ rf' = "none"
StopPorts == StopPortsRq("none")

\* recover(kind) (lifecycle.ts:684). Call it only after the active() check; `c0` is the state it starts from.
RecoverPost(kind, rq0, c0) ==
    IF rq0 # "none"
    THEN /\ rq' = (IF RqRule = "syncWins" /\ rq0 = "sync" THEN "sync" ELSE kind)
         /\ conn' = c0
         /\ UNCHANGED <<fib, fibE, fibKind, pk, okS, okM>>
    ELSE /\ rq' = kind
         /\ fib' = "grace" /\ fibE' = epoch /\ fibKind' = kind /\ pk' = "none" /\ okS' = FALSE /\ okM' = FALSE
         /\ conn' = (IF (kind = "sync" /\ syncP = "terminal") \/ (kind = "media" /\ mediaP = "failed") THEN "reconnecting" ELSE c0)

\* ---- The user ---------------------------------------------------------------

UserJoin ==
    /\ conn \in {"idle", "left", "failed"} /\ epoch < MaxEpoch /\ ~Has("join")
    /\ q' = Append(q, Item("join", 0, "none"))
    /\ UNCHANGED <<conn, epoch, busy, worldV, recV, accV, budV, histV>>

\* leave(): joinCancelled, interrupt the join, enqueue performLeave.
UserLeave ==
    /\ conn \notin {"idle", "leaving"} /\ ~Has("leave") /\ lvs < MaxLeaves
    /\ q' = Append(q, Item("leave", 0, "none"))
    /\ busy' = (IF busy = "join" THEN "none" ELSE busy)
    /\ lvs' = lvs + 1
    /\ UNCHANGED <<conn, epoch, worldV, recV, accV, sf, mf, tf, rfault, histV>>

\* ---- The actor: one queue item at a time -----------------------------------

CanTake(t) == busy = "none" /\ q # <<>> /\ q[1].t = t

\* performJoin (lifecycle.ts:473): a new epoch, new clients.
ProcessJoin ==
    /\ CanTake("join")
    /\ q' = Tail(q)
    /\ UNCHANGED budV
    /\ IF conn \in {"idle", "left", "failed"}
       THEN /\ epoch' = epoch + 1 /\ conn' = "joining" /\ busy' = "join"
            /\ syncP' = "connecting" /\ term' = "none" /\ mediaP' = "connecting" /\ syncDead' = FALSE
            /\ rq' = "none" /\ FibIdle
            /\ grant' = "fresh" /\ rf' = "none"
            /\ leaveRan' = FALSE /\ endObserved' = FALSE /\ removalSeen' = FALSE /\ removedByHost' = FALSE /\ restartInLeave' = FALSE
       ELSE UNCHANGED <<epoch, conn, busy, worldV, recV, accV, histV>>

JoinSucceeds ==
    /\ busy = "join" /\ conn = "joining" /\ syncP = "live" /\ mediaP \in {"live", "recovering", "failed"}
    /\ busy' = "none"
    /\ UNCHANGED <<epoch, q, worldV, grant, budV, histV>>
    /\ rf' = "sleep"   \* scheduleRefresh()
    /\ IF mediaP # "live"
       THEN RecoverPost("media", "none", "live")   \* recover("media") right after transition("live")
       ELSE /\ conn' = "live" /\ UNCHANGED recV

JoinFails ==
    /\ busy = "join" /\ conn = "joining"
    /\ conn' = "failed" /\ busy' = "none" /\ StopPorts
    /\ UNCHANGED <<epoch, q, budV, histV>>

\* handleSyncSnapshot (lifecycle.ts:940): terminal snapshots first, then recovery.
ProcessSnapS ==
    /\ CanTake("snapS")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, budV>>
    /\ IF syncP = "stopped"
       THEN UNCHANGED <<conn, worldV, recV, accV, histV>>
       ELSE IF syncP = "terminal" /\ (term = "episode_ended" \/ (term = "participant_removed" /\ Break # "removed_not_final"))
       THEN \* settleTerminalSnapshot -> finishTerminalSnapshot: leaving, stopPorts, left
            /\ conn' = "left" /\ StopPortsRq(IF Break = "ended_keeps_rq" THEN rq ELSE "none")
            /\ endObserved' = TRUE
            /\ removalSeen' = (removalSeen \/ term = "participant_removed")
            /\ removedByHost' = (removedByHost \/ term = "participant_removed")
            /\ UNCHANGED <<leaveRan, restartInLeave>>
       ELSE IF syncP = "terminal" /\ term \in {"access_rejected", "participant_removed"}
       THEN \* failForSnapshot(invalid_access): failed
            /\ conn' = "failed" /\ StopPorts
            /\ removalSeen' = (removalSeen \/ term = "participant_removed")
            /\ UNCHANGED <<leaveRan, endObserved, removedByHost, restartInLeave>>
       ELSE IF Active /\ syncP \in {"connecting", "recovering", "terminal"}
       THEN /\ RecoverPost("sync", rq, conn)
            /\ UNCHANGED <<worldV, accV, histV>>
       ELSE UNCHANGED <<conn, worldV, recV, accV, histV>>

\* handleMediaSnapshot (lifecycle.ts:1124)
ProcessSnapM ==
    /\ CanTake("snapM")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, worldV, accV, budV, histV>>
    /\ IF Active /\ mediaP \in {"recovering", "failed"} /\ Break # "media_snap_no_recover"
       THEN RecoverPost("media", rq, conn)
       ELSE UNCHANGED <<conn, recV>>

\* finishRecovery (lifecycle.ts:800)
ProcessFin ==
    /\ CanTake("fin")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, worldV, budV, histV>>
    /\ IF q[1].e = epoch /\ (Active \/ Break = "fin_ignores_active")
       THEN IF Break = "fin_skips_recheck"
            THEN /\ rq' = "none" /\ conn' = "live"
                 /\ UNCHANGED <<fib, fibE, fibKind, pk, okS, okM, accV>>
            ELSE IF syncP # "live" /\ Active
            THEN /\ RecoverPost("sync", "none", conn)
                 /\ UNCHANGED accV
            ELSE IF mediaP # "live" /\ Active
            THEN /\ RecoverPost("media", "none", conn)
                 /\ UNCHANGED accV
            ELSE /\ rq' = "none"
                 /\ conn' = (IF Break = "fin_forgets_live" THEN conn ELSE "live")
                 /\ rf' = (IF rf = "none" THEN "sleep" ELSE rf)
                 /\ UNCHANGED <<fib, fibE, fibKind, pk, okS, okM, grant>>
       ELSE UNCHANGED <<conn, recV, accV>>

\* The failure branch of the recovery loop (lifecycle.ts:722): failForSnapshot after a failure that cannot recover.
ProcessFail ==
    /\ CanTake("fail")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, budV, leaveRan, restartInLeave, removedByHost>>
    /\ IF q[1].e = epoch /\ Active
       THEN /\ conn' = (IF q[1].o = "episode_ended" THEN "left" ELSE "failed")
            /\ StopPorts
            /\ endObserved' = (endObserved \/ q[1].o = "episode_ended")
            /\ removalSeen' = (removalSeen \/ q[1].o = "participant_removed")
       ELSE UNCHANGED <<conn, worldV, recV, accV, endObserved, removalSeen>>

\* Exhaustion handler (lifecycle.ts:730): a sync plan with Sync live hands over to media; a sync plan with Sync
\* down fails the Connection; a media plan only reports and keeps going in the background.
ProcessExh ==
    /\ CanTake("exh")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, budV, histV>>
    /\ IF q[1].e = epoch /\ Active /\ pk = "sync" /\ syncP # "live"
       THEN /\ conn' = "failed" /\ StopPorts
       ELSE /\ UNCHANGED <<conn, worldV, accV>>
            /\ rq' = (IF q[1].e = epoch /\ Active /\ pk = "sync" /\ syncP = "live" THEN "media" ELSE rq)
            /\ fib' = (IF fib = "waitExh" THEN "afterExh" ELSE fib)
            /\ UNCHANGED <<fibE, fibKind, pk, okS, okM>>

\* restartSync's enqueue (lifecycle.ts:869): a new Sync client replaces the dead one.
ProcessRest ==
    /\ CanTake("rest")
    /\ UNCHANGED <<epoch, busy, budV, histV, conn, rq, accV, syncDead, mediaP>>
    /\ IF q[1].e = epoch /\ Active
       THEN /\ q' = PushSnap(Tail(q), "snapS")
            /\ syncP' = "connecting" /\ term' = "none"
            /\ okS' = FALSE
            /\ fib' = (IF fib = "waitRest" THEN "attempt" ELSE fib)
            /\ UNCHANGED <<fibE, fibKind, pk, okM>>
       ELSE /\ q' = Tail(q)
            /\ UNCHANGED <<syncP, term>>
            /\ IF fib = "waitRest" THEN FibIdle ELSE UNCHANGED <<fib, fibE, fibKind, pk, okS, okM>>

\* performLeave (lifecycle.ts:604)
ProcessLeave ==
    /\ CanTake("leave")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, worldV, accV, budV, endObserved, removalSeen, removedByHost, restartInLeave>>
    /\ IF conn \in {"idle", "left"}
       THEN UNCHANGED <<conn, busy, recV, leaveRan>>
       ELSE /\ conn' = "leaving" /\ busy' = "leave" /\ leaveRan' = TRUE
            /\ IF LeaveRule = "stops" THEN (rq' = "none" /\ FibIdle) ELSE UNCHANGED recV   \* stopRecovery

LeaveEnds ==
    /\ busy = "leave"
    /\ conn' = "left" /\ busy' = "none" /\ StopPorts
    /\ UNCHANGED <<epoch, q, budV, histV>>

\* The refresh result (lifecycle.ts:326): invalid access fails the Connection; unavailable retries with backoff,
\* timed to land when the grant runs out. A refresh that fails once the grant has run out fails the Connection with
\* access_unavailable (GrantRule "failsOnExpiry"). The lifecycle only learns that the grant ran out from that
\* failed refresh, so under "failsOnExpiry" the model has no separate expired state to sit live on.
ProcessRefr ==
    /\ CanTake("refr")
    /\ q' = Tail(q)
    /\ UNCHANGED <<epoch, busy, budV, histV>>
    /\ IF q[1].e = epoch /\ Active
       THEN IF q[1].o = "ok"
            THEN /\ grant' = "fresh" /\ rf' = "sleep" /\ UNCHANGED <<conn, worldV, recV>>
            ELSE IF q[1].o = "unavailable"
            THEN \/ /\ rf' = "sleep" /\ UNCHANGED <<conn, worldV, recV, grant>>
                 \/ /\ GrantRule = "failsOnExpiry" /\ grant = "stale"
                    /\ conn' = "failed" /\ StopPorts
            ELSE IF Break = "refresh_invalid_retries"
            THEN /\ grant' = "revoked" /\ rf' = "sleep" /\ UNCHANGED <<conn, worldV, recV>>
            ELSE /\ conn' = "failed" /\ StopPorts
       ELSE UNCHANGED <<conn, worldV, recV, accV>>

\* ---- Recovery fiber (lifecycle.ts:697-753) ---------------------------------

FiberGrace ==
    /\ fib = "grace"
    /\ IF Phase(fibKind) = "live"
       THEN /\ q' = Append(q, Item("fin", fibE, "none")) /\ FibIdle
       ELSE /\ q' = Append(q, Item("rec", fibE, "none")) /\ fib' = "waitRec" /\ UNCHANGED <<fibE, fibKind, pk, okS, okM>>
    /\ UNCHANGED <<conn, epoch, busy, worldV, rq, accV, budV, histV>>

ProcessRec ==
    /\ CanTake("rec")
    /\ q' = Tail(q)
    /\ conn' = (IF q[1].e = epoch /\ (Active \/ Break = "rec_ignores_active") THEN "reconnecting" ELSE conn)
    /\ fib' = (IF fib = "waitRec" THEN "loopHead" ELSE fib)
    /\ UNCHANGED <<epoch, busy, worldV, rq, fibE, fibKind, pk, okS, okM, accV, budV, histV>>

\* `recoveryPlan(model.recoveryQueued ?? kind)` at the top of each cycle (lifecycle.ts:713).
PlanCycle ==
    /\ fib = "loopHead"
    /\ IF epoch = fibE /\ Active
       THEN /\ fib' = "attempt" /\ pk' = (IF rq # "none" THEN rq ELSE fibKind)
            /\ okS' = FALSE /\ okM' = FALSE /\ UNCHANGED <<fibE, fibKind>>
       ELSE FibIdle
    /\ UNCHANGED <<coreV, worldV, rq, accV, budV, histV>>

\* recoverSync / recoverMedia return once their transport is live.
AttemptSeesSync ==
    /\ fib = "attempt" /\ syncP = "live" /\ ~okS
    /\ okS' = TRUE
    /\ UNCHANGED <<coreV, worldV, rq, fib, fibE, fibKind, pk, okM, accV, budV, histV>>

AttemptSeesMedia ==
    /\ fib = "attempt" /\ mediaP = "live" /\ ~okM
    /\ okM' = TRUE
    /\ UNCHANGED <<coreV, worldV, rq, fib, fibE, fibKind, pk, okS, accV, budV, histV>>

\* recoverMedia: access.replaceMedia() then media.restart(); nothing here checks Leave. When another caller already replaced
\* the binding, replaceMedia answers created: false and the attempt fails and is retried, which the model leaves to its failure budget.
AttemptRestartMedia ==
    /\ fib = "attempt" /\ mediaP = "failed"
    /\ mediaP' = "recovering" /\ q' = PushSnap(q, "snapM")
    /\ okM' = FALSE
    /\ restartInLeave' = (restartInLeave \/ conn = "leaving")
    /\ UNCHANGED <<conn, epoch, busy, syncP, term, syncDead, rq, fib, fibE, fibKind, pk, okS, accV, budV, leaveRan, endObserved, removalSeen, removedByHost>>

\* recoverSync: a terminal Sync client that may recover is replaced (access.getSyncToken, then createSyncClient).
AttemptRestartSync ==
    /\ fib = "attempt" /\ syncP = "terminal" /\ term = "transient"
    /\ q' = Append(q, Item("rest", fibE, "none")) /\ fib' = "waitRest"
    /\ restartInLeave' = (restartInLeave \/ conn = "leaving")
    /\ UNCHANGED <<conn, epoch, busy, worldV, rq, fibE, fibKind, pk, okS, okM, accV, budV, leaveRan, endObserved, removalSeen, removedByHost>>

AttemptSucceeds ==
    /\ fib = "attempt" /\ okS /\ okM
    /\ q' = Append(q, Item("fin", fibE, "none")) /\ FibIdle
    /\ UNCHANGED <<conn, epoch, busy, worldV, rq, accV, budV, histV>>

\* recoverSync fails with a failure that cannot recover (terminal Sync, access rejected).
AttemptFatal ==
    /\ fib = "attempt" /\ syncP = "terminal" /\ term \notin {"transient", "none"}
    /\ q' = Append(q, Item("fail", fibE, term)) /\ FibIdle
    /\ UNCHANGED <<conn, epoch, busy, worldV, rq, accV, budV, histV>>

\* The budget runs out (time is not modeled). It cannot run out on a world that is live in both transports,
\* or before the attempt has restarted a failed media or a terminal Sync that may recover.
AttemptExhausted ==
    /\ fib = "attempt" /\ ~(okS /\ okM) /\ ~(syncP = "live" /\ mediaP = "live")
    /\ mediaP # "failed" /\ ~(syncP = "terminal" /\ term = "transient")
    /\ q' = Append(q, Item("exh", fibE, "none")) /\ fib' = "waitExh"
    /\ UNCHANGED <<conn, epoch, busy, worldV, rq, fibE, fibKind, pk, okS, okM, accV, budV, histV>>

AfterExh ==
    /\ fib = "afterExh"
    /\ fib' = (IF rq # pk THEN "loopHead" ELSE "backoff")
    /\ UNCHANGED <<coreV, worldV, rq, fibE, fibKind, pk, okS, okM, accV, budV, histV>>

BackoffWakes ==
    /\ fib = "backoff"
    /\ fib' = "loopHead"
    /\ UNCHANGED <<coreV, worldV, rq, fibE, fibKind, pk, okS, okM, accV, budV, histV>>

\* ---- Access grant (lifecycle.ts:301-348) -----------------------------------

\* The refresh fiber wakes before the grant runs out, so a grant only expires after a refresh has failed.
GrantAges ==
    /\ Active /\ grant \in {"fresh", "stale"} /\ (grant = "fresh" \/ (rfault > 0 /\ GrantRule = "staysLive"))
    /\ grant' = (IF grant = "fresh" THEN "stale" ELSE "expired")
    /\ UNCHANGED <<coreV, worldV, recV, rf, budV, histV>>

RefreshStarts ==
    /\ Active /\ rf = "sleep" /\ grant \in {"stale", "expired"}
    /\ rf' = "flight"
    /\ UNCHANGED <<coreV, worldV, recV, grant, budV, histV>>

RefreshReturns ==
    /\ rf = "flight"
    /\ \E o \in {"ok", "unavailable", "invalid"} :
         /\ (o # "ok") => rfault < MaxRefreshFaults
         /\ q' = Append(q, Item("refr", epoch, o))
         /\ rfault' = (IF o = "ok" THEN rfault ELSE rfault + 1)
    /\ rf' = "returning"
    /\ UNCHANGED <<conn, epoch, busy, worldV, recV, grant, sf, mf, tf, lvs, histV>>

\* ---- The world: Sync and media move on their own ---------------------------

SyncDials ==
    /\ syncP = "connecting" /\ ~syncDead
    /\ syncP' = "recovering" /\ q' = PushSnap(q, "snapS")
    /\ UNCHANGED <<conn, epoch, busy, term, mediaP, syncDead, recV, accV, budV, histV>>

SyncWelcome ==
    /\ syncP = "recovering" /\ ~syncDead
    /\ syncP' = "live" /\ q' = PushSnap(q, "snapS")
    /\ UNCHANGED <<conn, epoch, busy, term, mediaP, syncDead, recV, accV, budV, histV>>

SyncDrops ==
    /\ syncP \in {"live", "recovering"} /\ sf < MaxSyncFaults
    /\ syncP' = "connecting" /\ q' = PushSnap(q, "snapS") /\ sf' = sf + 1
    /\ UNCHANGED <<conn, epoch, busy, term, mediaP, syncDead, recV, accV, mf, tf, rfault, lvs, histV>>

SyncDies ==
    /\ SyncMayDie /\ ~syncDead /\ syncP \in {"live", "recovering"} /\ sf < MaxSyncFaults
    /\ syncP' = "connecting" /\ syncDead' = TRUE /\ q' = PushSnap(q, "snapS") /\ sf' = sf + 1
    /\ UNCHANGED <<conn, epoch, busy, term, mediaP, recV, accV, mf, tf, rfault, lvs, histV>>

SyncTerminates ==
    /\ syncP \in {"connecting", "recovering", "live"} /\ tf < MaxTerminal
    /\ \E r \in {"episode_ended", "participant_removed", "access_rejected", "transient"} :
         (syncP' = "terminal" /\ term' = r)
    /\ q' = PushSnap(q, "snapS") /\ tf' = tf + 1
    /\ UNCHANGED <<conn, epoch, busy, mediaP, syncDead, recV, accV, sf, mf, rfault, lvs, histV>>

MediaConnects ==
    /\ mediaP = "connecting"
    /\ mediaP' = "live" /\ q' = PushSnap(q, "snapM")
    /\ UNCHANGED <<conn, epoch, busy, syncP, term, syncDead, recV, accV, budV, histV>>

MediaDrops ==
    /\ mediaP = "live" /\ mf < MaxMediaFaults
    /\ mediaP' = "recovering" /\ q' = PushSnap(q, "snapM") /\ mf' = mf + 1
    /\ UNCHANGED <<conn, epoch, busy, syncP, term, syncDead, recV, accV, sf, tf, rfault, lvs, histV>>

MediaHeals ==
    /\ mediaP = "recovering"
    /\ mediaP' = "live" /\ q' = PushSnap(q, "snapM")
    /\ UNCHANGED <<conn, epoch, busy, syncP, term, syncDead, recV, accV, budV, histV>>

MediaFails ==
    /\ mediaP = "recovering"
    /\ mediaP' = "failed" /\ q' = PushSnap(q, "snapM")
    /\ UNCHANGED <<conn, epoch, busy, syncP, term, syncDead, recV, accV, budV, histV>>

Next ==
    \/ UserJoin \/ UserLeave
    \/ ProcessJoin \/ JoinSucceeds \/ JoinFails
    \/ ProcessSnapS \/ ProcessSnapM \/ ProcessFin \/ ProcessFail \/ ProcessExh \/ ProcessRest \/ ProcessRec
    \/ ProcessLeave \/ LeaveEnds \/ ProcessRefr
    \/ FiberGrace \/ PlanCycle \/ AttemptSeesSync \/ AttemptSeesMedia \/ AttemptRestartMedia \/ AttemptRestartSync
    \/ AttemptSucceeds \/ AttemptFatal \/ AttemptExhausted \/ AfterExh \/ BackoffWakes
    \/ GrantAges \/ RefreshStarts \/ RefreshReturns
    \/ SyncDials \/ SyncWelcome \/ SyncDrops \/ SyncDies \/ SyncTerminates
    \/ MediaConnects \/ MediaDrops \/ MediaHeals \/ MediaFails

\* Everything the code does by itself must eventually happen. A Sync or media client that keeps trying
\* eventually connects (strong fairness, because a media that fails between tries is only intermittently
\* able to heal). The user, the faults and Sync dying are not forced.
Fair ==
    /\ WF_vars(ProcessJoin) /\ WF_vars(JoinSucceeds) /\ WF_vars(JoinFails)
    /\ WF_vars(ProcessSnapS) /\ WF_vars(ProcessSnapM) /\ WF_vars(ProcessFin) /\ WF_vars(ProcessFail)
    /\ WF_vars(ProcessExh) /\ WF_vars(ProcessRest) /\ WF_vars(ProcessRec) /\ WF_vars(ProcessLeave)
    /\ WF_vars(LeaveEnds) /\ WF_vars(ProcessRefr)
    /\ WF_vars(FiberGrace) /\ WF_vars(PlanCycle) /\ WF_vars(AttemptSeesSync) /\ WF_vars(AttemptSeesMedia)
    /\ WF_vars(AttemptRestartMedia) /\ WF_vars(AttemptRestartSync) /\ WF_vars(AttemptSucceeds)
    /\ WF_vars(AttemptFatal) /\ WF_vars(AttemptExhausted) /\ WF_vars(AfterExh) /\ WF_vars(BackoffWakes)
    /\ WF_vars(RefreshStarts) /\ WF_vars(RefreshReturns)
    /\ SF_vars(SyncDials) /\ SF_vars(SyncWelcome) /\ SF_vars(MediaConnects) /\ SF_vars(MediaHeals)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fair

\* ---- Rules -------------------------------------------------------------------

\* A Leave that has started is never undone: the Connection stays leaving or left until the next join.
LeaveNotUndone == leaveRan => conn \in {"leaving", "left"}

\* Once Leave has started, no recovery attempt reaches for a new Sync token or a new media connection.
NoRestartWhileLeaving == ~restartInLeave

\* Whenever the lifecycle has handled everything it was told and Sync or media is down, a recovery is pending.
Pending == busy # "none" \/ \E i \in 1..Len(q) : q[i].t \in {"snapS", "snapM", "fin", "fail", "exh", "rec", "rest"}
NoAbandonedRecovery == (Active /\ ~Pending /\ (syncP # "live" \/ mediaP # "live")) => rq # "none"

\* A terminal episode_ended or removal frame ends the call at once: left, nothing running, nothing to reconnect.
EndingIsFinal ==
    endObserved => (conn = "left" /\ rq = "none" /\ fib = "none" /\ syncP = "stopped" /\ mediaP = "idle")
\* A removal the lifecycle saw is reported as removedByHost, whichever way the call ended.
RemovalReported == (removalSeen /\ conn \in {"left", "failed"}) => removedByHost

\* An access grant the server rejected never leaves the client live.
RevokedGrantNotLive == grant = "revoked" => ~Active
\* An expired grant (the refresh keeps failing) never leaves the client live.
ExpiredGrantNotLive == grant = "expired" => conn # "live"

\* A recovery that is under way ends: live again, failed, or left. With SyncMayDie this says that a Sync
\* that never comes back ends the Connection, whichever transport complained last.
RecoveryEnds == (conn = "reconnecting") ~> (conn # "reconnecting")
=============================================================================
