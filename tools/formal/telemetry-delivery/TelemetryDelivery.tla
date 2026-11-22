------------------------- MODULE TelemetryDelivery -------------------------
(***************************************************************************)
(* Delivery conservation for client telemetry (contract C3, see           *)
(* docs/telemetry-delivery.md).                                            *)
(*                                                                         *)
(* One device runs client sessions one after another: a boot is one page  *)
(* or app run. Each join is one source with its own seq counter from 0: a *)
(* boot starts a source, and a boot that joins as another Participant      *)
(* retires its source (it closes at its exact high-water mark) and starts  *)
(* a new one. The outbox (sdks/typescript/client/src/telemetry/outbox.ts)  *)
(* holds every record in memory and keeps P0 records, the pending drop     *)
(* list and the high-water mark in a journal that survives a reload        *)
(* (journal.ts). After a reload the new boot sends what its predecessors   *)
(* left, each under its own source and credential, and says how each       *)
(* source ended. A closing source names its drop list in a record of its   *)
(* own; an abandoned one cannot, because its saved high-water mark is only *)
(* a lower bound, so its drop list is given up and those seqs stay a gap.  *)
(*                                                                         *)
(* The ingest route commits the ledger and accepted payload together.     *)
(* It may ACK as soon as the transaction commits. A failed commit stores  *)
(* nothing. A crash after commit but before ACK or export leaves a durable *)
(* row for the relay; a duplicate retry can safely ACK. The relay moves   *)
(* pending rows to the sink independently. A rejected record is settled *)
(* but not stored, so it is a gap. An end below history is refused.       *)
(* Another Participant of the tenant that learned a source_id may send a   *)
(* forged batch or end for it (Foreign); the owner check refuses it.       *)
(*                                                                         *)
(* Assumptions. A sink receipt confirms the full row; accepted rows stay   *)
(* for the read horizon. Retries collapse by a stable record key. A failed *)
(* export or lost receipt may leave the payload pending. Successful send  *)
(* and deletion are one abstract step. Every source's credential is       *)
(* valid while the client sends for it (the code abandons a source whose   *)
(* credential expired, and its gap stays open; the model does not cover    *)
(* that). The journal survives a reload. The tenant and Participant stay   *)
(* live (the purge fence is checked in the ledger tests, not here). The    *)
(* model does not cover the byte budget (eviction is a step under one cap  *)
(* over every lane, and the reserve rule is checked), the source budget,   *)
(* or a page restored from the back-forward cache after pagehide.          *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxBoots,         \* client sessions on the device, so MaxBoots - 1 reloads
    MaxJoins,         \* joins as another Participant inside one boot, all boots together
    MaxRecords,       \* records each join makes, besides drop records
    Cap,              \* records the queue holds before it evicts (drop records are exempt)
    CheckCap,         \* FALSE in trace validation: the code evicts by bytes, not by count
    MaxFaults,        \* API crashes, lost requests or answers, partial answers, rejected
                      \* records, stale ends and timeouts of a request still on its way, all together
    MayVanish,        \* the last boot may die and never come back
    Break             \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "ack_before_store",          \* the handler answers before the ledger commit
    "sink_before_ledger",        \* the handler writes the sink before the ledger commits
    "omit_payload_on_commit",   \* the ledger commits the range without the payload
    "rejected_as_stored",        \* the ledger counts a rejected record as stored
    "accept_short_end",          \* the ledger applies an end below the committed history
    "send_before_save",          \* a batch leaves before the journal saves its high-water mark
    "one_source_across_joins",   \* a join as another Participant keeps the source
    "dedupe_on_seq_only",        \* the ledger keys dedupe on seq, not on (source_id, seq)
    "reuse_source_on_reload",    \* a reloaded client keeps its source_id and counts seq from 0 again
    "evict_without_drop_record", \* the queue evicts without adding the seq to the drop list
    "volatile_drop_list",        \* the drop list lives in memory only, not in the journal
    "ack_whole_batch",           \* a 200 settles the whole batch, not only the seqs it names
    "no_p0_reserve",             \* eviction ignores priority, so routine records push out P0
    "abandoned_as_closed",       \* a successor reports a predecessor closed without its closing mark
    "ignore_journal_on_reload",  \* a reloaded client keeps the journal but never sends what it holds
    "name_abandoned_drops",      \* a reload names an abandoned predecessor's drop list at its saved mark
    "no_owner_check"             \* the ledger lets any Participant of the tenant write a source
}

ASSUME MaxBoots \in 1..3 /\ MaxJoins \in 0..2 /\ MaxRecords \in 1..8 /\ Cap \in 1..4 /\ MaxFaults \in 0..9
ASSUME CheckCap \in BOOLEAN /\ MayVanish \in BOOLEAN
ASSUME Break \in BreakNames

Sources == 1..(MaxBoots + MaxJoins)
Keys == Sources \X Nat
Ends == {"", "abandoned", "closed"}

NoMsg == [src |-> 0, recs |-> {}, next |-> 0, end |-> "", boot |-> 0, who |-> 0]
Idle == [st |-> "idle", m |-> NoMsg, settle |-> {}, rejected |-> {}, new |-> {}]
NoRow == [owner |-> 0, stored |-> {}, rejected |-> {}, dropped |-> {}, reported |-> 0, end |-> "", endNext |-> 0]
\* A Participant of the tenant the client never joins as: client credentials name 1..MaxJoins + 1.
Foreigner == MaxJoins + 2

VARIABLES
    boot,      \* the client session running now (1..MaxBoots)
    alive,     \* whether that session is running
    src,       \* the source it writes as now
    last,      \* the highest source any join has started
    joins,     \* joins as another Participant so far
    who,       \* the Participant the live credential speaks for
    part,      \* part[s]: the Participant source s belongs to, whose credential sends it
    closed,    \* the session was disposed: its source takes no more records
    made,      \* records this join made, besides drop records
    next,      \* next[s]: the seq source s assigns next (memory)
    mem,       \* records the running session holds, settled ones removed
    jrecs,     \* journal: durable records not yet settled
    jnext,     \* journal: high-water mark per source, as of the last save
    jclosing,  \* journal: the source saved its exact high-water mark as it closed
    pdrops,    \* journal: keys evicted and not yet in a drop record
    toEnd,     \* toEnd[s]: the end the client still has to report for source s
    out,       \* out[s]: the request in flight for source s, or NoMsg
    reqs,      \* requests on their way to the API
    resps,     \* answers on their way back
    ledger,    \* ledger[s]: what the API has committed for source s
    sink,      \* rows written: records and drop records
    pending,   \* payload committed alongside the source ranges
    srv,       \* the batch the API is handling, if any
    assigned,  \* ghost: every record any boot made
    durable,   \* ghost: every record that was durably enqueued
    p0OverLow, \* ghost: a P0 record was evicted while a routine one was held
    gaveUp,    \* ghost: keys in the drop list of an abandoned source, never named
    faults     \* faults so far

clientVars == <<boot, alive, src, last, joins, who, part, closed, made, next, mem, jrecs, jnext, jclosing, pdrops, toEnd, out>>
netVars == <<reqs, resps>>
serverVars == <<ledger, sink, pending, srv>>
ghostVars == <<assigned, durable, p0OverLow, gaveUp>>
faultVars == <<faults>>
vars == <<clientVars, netVars, serverVars, ghostVars, faultVars>>

Key(r) == <<r.src, r.seq>>
Max(a, b) == IF a >= b THEN a ELSE b
IsDrop(r) == r.covers # {}
Counted(S) == {r \in S : ~IsDrop(r)}
Lane(s) == {r \in mem : r.src = s}
DropsOf(s) == {k \in pdrops : k[1] = s}
\* One past the highest seq of a set, or 0.
Past(S) == IF S = {} THEN 0 ELSE 1 + CHOOSE q \in S : \A p \in S : p <= q
\* The committed history an end may not hide: past every stored or rejected seq, and at
\* least every next_seq reported.
Floor(L) == Max(Past(L.stored \cup L.rejected), L.reported)
\* The high-water mark a batch carries: exact for the live source, the journal's otherwise.
Mark(s) == IF s = src /\ alive THEN next[s] ELSE jnext[s]

Init ==
    /\ boot = 1 /\ alive = TRUE /\ src = 1 /\ last = 1 /\ joins = 0 /\ who = 1 /\ closed = FALSE /\ made = 0
    /\ part = [s \in Sources |-> IF s = 1 THEN 1 ELSE 0]
    /\ next = [s \in Sources |-> 0]
    /\ mem = {} /\ jrecs = {}
    /\ jnext = [s \in Sources |-> 0]
    /\ jclosing = [s \in Sources |-> FALSE]
    /\ pdrops = {}
    /\ toEnd = [s \in Sources |-> ""]
    /\ out = [s \in Sources |-> NoMsg]
    /\ reqs = {} /\ resps = {}
    /\ ledger = [s \in Sources |-> NoRow]
    /\ sink = {} /\ pending = {} /\ srv = Idle
    /\ assigned = {} /\ durable = {} /\ p0OverLow = FALSE /\ gaveUp = {}
    /\ faults = 0

-----------------------------------------------------------------------------
(* The client: TelemetryOutbox, EventQueue and the journal.                *)

\* record(): stamps (source_id, seq, event_id) and queues it. A P0 record is saved to the
\* journal with the high-water mark before record() returns, so it is durable at once.
Record(p0) ==
    /\ alive /\ ~closed /\ made < MaxRecords
    /\ ~CheckCap \/ Cardinality(Counted(mem)) <= Cap
    /\ LET r == [src |-> src, seq |-> next[src], eid |-> boot, p0 |-> p0, covers |-> {}]
       IN /\ mem' = mem \cup {r}
          /\ assigned' = assigned \cup {r}
          /\ IF p0
                THEN /\ durable' = durable \cup {r}
                     /\ jrecs' = jrecs \cup {r}
                     /\ jnext' = [jnext EXCEPT ![src] = next[src] + 1]
                ELSE UNCHANGED <<durable, jrecs, jnext>>
    /\ next' = [next EXCEPT ![src] = @ + 1]
    /\ made' = made + 1
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, jclosing, pdrops, toEnd, out, netVars, serverVars, p0OverLow, gaveUp, faultVars>>

\* The queue gives up routine records first: a P0 record goes only when no routine one is left.
Victim(v) ==
    /\ v \in mem /\ ~IsDrop(v)
    /\ Break = "no_p0_reserve" \/ (v.p0 => \A u \in Counted(mem) : u.p0)

\* EventQueue eviction (and folding of stats windows, which evicts the older window). Only the
\* live source's queue takes new records, so only it evicts. The evicted key joins the drop
\* list, which is saved with the journal.
Evict(v) ==
    /\ alive /\ ~closed /\ v.src = src
    /\ ~CheckCap \/ Cardinality(Counted(mem)) > Cap
    /\ Victim(v)
    /\ mem' = mem \ {v}
    /\ jrecs' = jrecs \ {v}
    /\ pdrops' = IF Break = "evict_without_drop_record" THEN pdrops ELSE pdrops \cup {Key(v)}
    /\ p0OverLow' = (p0OverLow \/ (v.p0 /\ \E u \in Counted(mem) : ~u.p0))
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, next, jnext, jclosing, toEnd, out, netVars, serverVars, assigned, durable, gaveUp, faultVars>>

\* A drain turns a source's drop list into a telemetry_dropped record of that same source. The
\* live source does it while it takes records; a retired source only while it is closing and
\* has not sent its end, because only then is its high-water mark exact. The outbox emits a
\* drop record only while no earlier one is unsettled, except as it closes; the model lets it
\* emit at any time, which covers both. Drop records are never evicted.
EmitDrop(s) ==
    /\ alive /\ DropsOf(s) # {}
    /\ IF s = src THEN ~closed ELSE (jclosing[s] \/ Break = "name_abandoned_drops") /\ toEnd[s] # "" /\ out[s] = NoMsg
    /\ LET q == Mark(s)
           d == [src |-> s, seq |-> q, eid |-> boot, p0 |-> TRUE, covers |-> DropsOf(s)]
       IN /\ mem' = mem \cup {d}
          /\ jrecs' = jrecs \cup {d}
          /\ assigned' = assigned \cup {d}
          /\ durable' = durable \cup {d}
          /\ pdrops' = pdrops \ DropsOf(s)
          /\ jnext' = [jnext EXCEPT ![s] = q + 1]
          /\ next' = [next EXCEPT ![s] = q + 1]
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, jclosing, toEnd, out, netVars, serverVars, p0OverLow, gaveUp, faultVars>>

\* The throttled journal save that moves the high-water mark without a P0 record.
Checkpoint ==
    /\ alive /\ jnext[src] # next[src]
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, next, mem, jrecs, jclosing, pdrops, toEnd, out, netVars, serverVars, ghostVars, faultVars>>

\* One batch per source in flight, holding what the lane has (the code caps a batch at 100
\* events, which the bounds here never reach), under the credential of the source's own
\* Participant. A batch carries the source's high-water mark, which the journal saves before
\* the batch leaves, and the end the client owes for it. A retired source names its drop list
\* before it sends.
Send(s) ==
    /\ alive /\ out[s] = NoMsg
    /\ Lane(s) # {} \/ toEnd[s] # ""
    /\ s # src => DropsOf(s) = {}
    /\ LET m == [src |-> s, recs |-> Lane(s), next |-> Mark(s), end |-> toEnd[s], boot |-> boot, who |-> IF s = src THEN who ELSE part[s]]
       IN /\ reqs' = reqs \cup {m}
          /\ out' = [out EXCEPT ![s] = m]
    /\ jnext' = IF s = src /\ Break # "send_before_save" THEN [jnext EXCEPT ![s] = next[s]] ELSE jnext
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, next, mem, jrecs, jclosing, pdrops, toEnd, resps, serverVars, ghostVars, faultVars>>

Answered(m) == \E a \in resps : a.req = m
Lost(m) == m \notin reqs /\ srv.m # m /\ ~Answered(m)

\* The send timeout aborts the request, so an answer that comes later is never read. After a
\* loss it always fires; while the request is still on its way it fires only within
\* MaxFaults, and the retry becomes a duplicate delivery.
Timeout(s) ==
    /\ alive /\ out[s] # NoMsg
    /\ IF Lost(out[s]) THEN UNCHANGED faults
       ELSE faults < MaxFaults /\ faults' = faults + 1
    /\ out' = [out EXCEPT ![s] = NoMsg]
    /\ resps' = {a \in resps : a.req # out[s]}
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, next, mem, jrecs, jnext, jclosing, pdrops, toEnd, reqs, serverVars, ghostVars>>

\* The answer settles the seqs it names and nothing else. An answer that carried the end
\* the client owed means the server has it.
Ack(a) ==
    /\ alive /\ a \in resps /\ a.req.boot = boot /\ out[a.req.src] = a.req
    /\ LET s == a.req.src
           settled == IF Break = "ack_whole_batch" THEN {Key(r) : r \in a.req.recs} ELSE {<<s, q>> : q \in a.acks}
       IN /\ mem' = {r \in mem : Key(r) \notin settled}
          /\ jrecs' = {r \in jrecs : Key(r) \notin settled}
          /\ toEnd' = IF a.req.end # "" THEN [toEnd EXCEPT ![s] = ""] ELSE toEnd
          /\ out' = [out EXCEPT ![s] = NoMsg]
    /\ resps' = resps \ {a}
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, closed, made, next, jnext, jclosing, pdrops, reqs, serverVars, ghostVars, faultVars>>

\* A credential of another Participant is another join. The live source retires: its exact
\* high-water mark and closing mark are saved, it owes a closed end, and it still names its
\* own drop list. The new join starts a new source that counts from 0.
Rejoin ==
    /\ alive /\ ~closed /\ joins < MaxJoins
    /\ joins' = joins + 1 /\ who' = who + 1 /\ made' = 0
    /\ IF Break = "one_source_across_joins"
          THEN UNCHANGED <<src, last, part, next, jnext, jclosing, toEnd>>
          ELSE /\ last' = last + 1 /\ src' = last + 1
               /\ part' = [part EXCEPT ![last + 1] = who + 1]
               /\ next' = [next EXCEPT ![last + 1] = 0]
               /\ jnext' = [jnext EXCEPT ![src] = next[src]]
               /\ jclosing' = [jclosing EXCEPT ![src] = TRUE]
               /\ toEnd' = [toEnd EXCEPT ![src] = "closed"]
    /\ UNCHANGED <<boot, alive, closed, mem, jrecs, pdrops, out, netVars, serverVars, ghostVars, faultVars>>

\* Requests already sent still reach the API; their answers have no one to read them.
Die ==
    /\ alive' = FALSE /\ mem' = {} /\ out' = [s \in Sources |-> NoMsg] /\ resps' = {}
    /\ pdrops' = IF Break = "volatile_drop_list" THEN {} ELSE pdrops

\* The page or app dies without warning: memory is gone, the journal stays.
Crash ==
    /\ alive /\ (boot < MaxBoots \/ MayVanish)
    /\ Die
    /\ UNCHANGED <<boot, src, last, joins, who, part, closed, made, next, jrecs, jnext, jclosing, toEnd, reqs, serverVars, ghostVars, faultVars>>

\* pagehide: the journal is saved with the exact high-water mark and the closing mark, then
\* the page goes (its last flush is an ordinary Send before this step).
PageHide ==
    /\ alive /\ ~closed /\ (boot < MaxBoots \/ MayVanish)
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ jclosing' = [jclosing EXCEPT ![src] = TRUE]
    /\ Die
    /\ UNCHANGED <<boot, src, last, joins, who, part, closed, made, next, jrecs, toEnd, reqs, serverVars, ghostVars, faultVars>>

\* dispose(): no record follows, so the high-water mark is exact. The drop list is emitted first.
Dispose ==
    /\ alive /\ ~closed /\ DropsOf(src) = {}
    /\ closed' = TRUE
    /\ toEnd' = [toEnd EXCEPT ![src] = "closed"]
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ jclosing' = [jclosing EXCEPT ![src] = TRUE]
    /\ UNCHANGED <<boot, alive, src, last, joins, who, part, made, next, mem, jrecs, pdrops, out, netVars, serverVars, ghostVars, faultVars>>

\* A reload: a new source, the predecessors' durable records taken over, and an end owed for
\* the last live source: closed when it saved its closing mark, abandoned otherwise. An
\* abandoned source's drop list is given up: a drop record minted at its saved high-water
\* mark could take the seq of a record the dead page made and lost.
Reboot ==
    /\ ~alive /\ boot < MaxBoots
    /\ LET nb == boot + 1
           ns == IF Break = "reuse_source_on_reload" THEN src ELSE last + 1
           closing == jclosing[src] \/ Break = "abandoned_as_closed"
           ended == IF closing THEN "closed" ELSE "abandoned"
           given == IF closing \/ Break = "name_abandoned_drops" THEN {} ELSE DropsOf(src)
       IN /\ boot' = nb
          /\ src' = ns
          /\ last' = Max(last, ns)
          /\ part' = [part EXCEPT ![ns] = who]
          /\ next' = [next EXCEPT ![ns] = 0]
          /\ toEnd' = IF ns # src THEN [toEnd EXCEPT ![src] = ended] ELSE toEnd
          /\ pdrops' = pdrops \ given
          /\ gaveUp' = gaveUp \cup given
    /\ alive' = TRUE /\ closed' = FALSE /\ made' = 0
    /\ mem' = IF Break = "ignore_journal_on_reload" THEN {} ELSE jrecs
    /\ UNCHANGED <<joins, who, jrecs, jnext, jclosing, out, netVars, serverVars, assigned, durable, p0OverLow, faultVars>>

-----------------------------------------------------------------------------
(* The API: the ingest handler and the source ledger.                      *)

\* Dedupe is against the seqs the batch's own source already stores or rejects. A seq a drop
\* record covers is still stored if its record arrives, so a late copy is not lost.
Fresh(r) ==
    IF Break = "dedupe_on_seq_only"
        THEN \A s \in Sources : r.seq \notin ledger[s].stored
        ELSE r.seq \notin ledger[r.src].stored \cup ledger[r.src].rejected

Owns(m) == Break = "no_owner_check" \/ ledger[m.src].owner \in {0, m.who}

\* The handler takes one batch under the source's row lock. It settles all of it, except when
\* a fault makes the answer settle only some of it, or makes the content check reject J.
Receive(m, S, J) ==
    /\ srv.st = "idle" /\ m \in reqs /\ Owns(m)
    /\ S \subseteq m.recs /\ J \subseteq m.recs \ S
    /\ IF S = m.recs THEN UNCHANGED faults ELSE faults < MaxFaults /\ faults' = faults + 1
    /\ reqs' = reqs \ {m}
    /\ srv' = [st |-> "admitted", m |-> m, settle |-> S \cup J, rejected |-> {r \in J : Fresh(r)}, new |-> {r \in S : Fresh(r)}]
    /\ resps' = IF Break = "ack_before_store" THEN resps \cup {[req |-> m, acks |-> {r.seq : r \in S \cup J}]} ELSE resps
    /\ UNCHANGED <<clientVars, ledger, sink, pending, ghostVars>>

\* A batch for a source another Participant owns is refused, and nothing of it is applied.
Refuse(m) ==
    /\ srv.st = "idle" /\ m \in reqs /\ ~Owns(m)
    /\ reqs' = reqs \ {m}
    /\ UNCHANGED <<clientVars, resps, serverVars, ghostVars, faultVars>>

\* A stale or forged close below the committed history reaches the API (a fault). No client
\* reads its answer.
StaleEnd(s) ==
    /\ faults < MaxFaults /\ ledger[s].owner # 0
    /\ \E n \in 0..(Floor(ledger[s]) - 1) :
         reqs' = reqs \cup {[src |-> s, recs |-> {}, next |-> n, end |-> "closed", boot |-> 0, who |-> ledger[s].owner]}
    /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, resps, serverVars, ghostVars>>

\* Another Participant's credential sends for a source it learned once the source was in use:
\* a forged record at a seq the source may hold, or a forged end at any mark (a fault). No
\* client reads its answer.
Foreign(s) ==
    /\ faults < MaxFaults /\ ledger[s].owner # 0
    /\ \E q \in 0..MaxRecords, e \in {"", "closed"} :
         LET forged == [src |-> s, seq |-> q, eid |-> 0, p0 |-> FALSE, covers |-> {}]
         IN reqs' = reqs \cup {[src |-> s, recs |-> IF e = "" THEN {forged} ELSE {}, next |-> q, end |-> e, boot |-> 0, who |-> Foreigner]}
    /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, resps, serverVars, ghostVars>>

\* The row after one batch: fresh valid records stored (a record at or past a closed end is
\* rejected instead), fresh invalid ones rejected, the seqs a stored drop record names
\* dropped, the end checked against the floor, then the high-water mark raised.
Applied(L, m, new, rej) ==
    LET after == IF L.end = "closed" THEN {r \in new : r.seq >= L.endNext} ELSE {}
        kept == new \ after
        stored == L.stored \cup {r.seq : r \in kept}
        rejected == L.rejected \cup {r.seq : r \in rej \cup after}
        R == [L EXCEPT !.owner = m.who, !.stored = IF Break = "rejected_as_stored" THEN stored \cup rejected ELSE stored, !.rejected = rejected,
                       !.dropped = @ \cup {k[2] : k \in UNION {d.covers : d \in kept}}]
        ending == m.end # "" /\ L.end # "closed" /\ (m.next >= Floor(R) \/ Break = "accept_short_end")
    IN [R EXCEPT !.reported = Max(L.reported, m.next),
                 !.end = IF ending THEN m.end ELSE L.end,
                 !.endNext = IF ending THEN m.next ELSE L.endNext]

\* The rows the commit stores, which the sink gets after it.
Rows(m, new) == IF ledger[m.src].end = "closed" THEN {r \in new : r.seq < ledger[m.src].endNext} ELSE new

\* One transaction for the range and evidence payload.
Commit ==
    /\ srv.st = IF Break = "sink_before_ledger" THEN "sunk" ELSE "admitted"
    /\ ledger' = [ledger EXCEPT ![srv.m.src] = Applied(@, srv.m, srv.new, srv.rejected)]
    /\ pending' = IF Break = "omit_payload_on_commit" THEN pending ELSE pending \cup Rows(srv.m, srv.new)
    /\ srv' = [srv EXCEPT !.st = "committed"]
    /\ UNCHANGED <<clientVars, netVars, sink, ghostVars, faultVars>>

\* Export is independent of the request. A retry has the same record key.
Write ==
    /\ pending # {}
    /\ sink' = sink \cup pending
    /\ pending' = {}
    /\ UNCHANGED <<clientVars, netVars, ledger, srv, ghostVars, faultVars>>

WriteEarly ==
    /\ Break = "sink_before_ledger" /\ srv.st = "admitted"
    /\ sink' = sink \cup srv.new
    /\ srv' = [srv EXCEPT !.st = "sunk"]
    /\ UNCHANGED <<clientVars, netVars, ledger, pending, ghostVars, faultVars>>

Respond ==
    /\ srv.st = "committed"
    /\ resps' = IF Break = "ack_before_store" \/ srv.m.boot = 0 THEN resps ELSE resps \cup {[req |-> srv.m, acks |-> {r.seq : r \in srv.settle}]}
    /\ srv' = Idle
    /\ UNCHANGED <<clientVars, reqs, ledger, sink, pending, ghostVars, faultVars>>

\* The API dies mid-batch. No committed range or payload is lost.
ServerCrash ==
    /\ srv.st # "idle" /\ faults < MaxFaults
    /\ srv' = Idle /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, netVars, ledger, sink, pending, ghostVars>>

LoseRequest(m) ==
    /\ m \in reqs /\ faults < MaxFaults
    /\ reqs' = reqs \ {m} /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, resps, serverVars, ghostVars>>

LoseAnswer(a) ==
    /\ a \in resps /\ faults < MaxFaults
    /\ resps' = resps \ {a} /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, reqs, serverVars, ghostVars>>

Next ==
    \/ \E p \in BOOLEAN : Record(p)
    \/ \E v \in mem : Evict(v)
    \/ \E s \in Sources : EmitDrop(s)
    \/ Checkpoint
    \/ \E s \in Sources : Send(s)
    \/ \E s \in Sources : Timeout(s)
    \/ \E a \in resps : Ack(a)
    \/ Rejoin \/ Crash \/ PageHide \/ Dispose \/ Reboot
    \/ \E m \in reqs : \E S \in SUBSET m.recs : \E J \in SUBSET (m.recs \ S) : Receive(m, S, J)
    \/ \E m \in reqs : Refuse(m)
    \/ \E s \in Sources : StaleEnd(s)
    \/ \E s \in Sources : Foreign(s)
    \/ Write \/ WriteEarly \/ Commit \/ Respond \/ ServerCrash
    \/ \E m \in reqs : LoseRequest(m)
    \/ \E a \in resps : LoseAnswer(a)

\* Progress assumptions for eventual accounting, and nothing more: the client sends what it
\* holds, times out a lost request, reads answers and comes back after a crash; the API
\* handles what reaches it and the relay can eventually export. Faults are bounded by the constants.
Fairness ==
    /\ \A s \in Sources : WF_vars(Send(s))
    /\ \A s \in Sources : WF_vars(alive /\ out[s] # NoMsg /\ Lost(out[s]) /\ Timeout(s))
    /\ WF_vars(\E a \in resps : Ack(a))
    /\ \A s \in Sources : WF_vars(EmitDrop(s))
    /\ WF_vars(Reboot)
    /\ WF_vars(\E m \in reqs : Receive(m, m.recs, {}))
    /\ WF_vars(\E m \in reqs : Refuse(m))
    /\ WF_vars(Write) /\ WF_vars(Commit) /\ WF_vars(Respond)

Spec == Init /\ [][Next]_vars
LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* What the server knows, and the rules.                                   *)

InSink(r) == r \in sink
Covered(k) == \E d \in sink : k \in d.covers
\* The client still has it: in memory, in the journal, in the drop list, or named by a
\* drop record it still holds.
HeldRecs == jrecs \cup mem
Held(r) ==
    \/ r \in HeldRecs
    \/ Key(r) \in pdrops
    \/ \E d \in HeldRecs : Key(r) \in d.covers

\* The reader may not see a pending row yet, but Postgres has its payload.
DurableRows == pending \cup sink
DurablyCovered(k) == \E d \in DurableRows : k \in d.covers

\* The join safety rules depend only on the durable payloads, not on which
\* store has them. Write stutters under this view; the liveness models use
\* the full state so they still check that the rows reach the sink.
JoinSafetyView == <<clientVars, netVars, ledger, DurableRows, srv, ghostVars, faultVars>>

\* The ledger's evidence gaps (telemetrydelivery.Gaps): below the high-water
\* mark every seq neither stored nor dropped is missing (rejections included);
\* past it, the tail is unknown unless the source closed. The readback tests
\* separately show that readers leave committed but unexported seqs unread.
High(s) == IF ledger[s].end = "closed" THEN ledger[s].endNext ELSE Max(ledger[s].reported, ledger[s].endNext)
Missing(s) == {q \in 0..(High(s) - 1) : q \notin ledger[s].stored \cup ledger[s].dropped}
TailUnknown(s) == ledger[s].end # "closed"
InGap(r) ==
    \/ r.seq \in Missing(r.src)
    \/ TailUnknown(r.src) /\ r.seq >= High(r.src)

\* A loss the server can name: a rejected record (including a rejected drop
\* record), or the unnamed drop list of an abandoned source.
Excused(k) ==
    \/ k \in gaveUp
    \/ k[2] \in ledger[k[1]].rejected
    \/ \E d \in assigned : IsDrop(d) /\ k \in d.covers /\ d.seq \in ledger[d.src].rejected

TypeOK ==
    /\ boot \in 1..MaxBoots /\ src \in Sources /\ last \in Sources /\ alive \in BOOLEAN /\ closed \in BOOLEAN
    /\ next \in [Sources -> Nat] /\ jnext \in [Sources -> Nat]
    /\ pdrops \subseteq Keys /\ gaveUp \subseteq Keys
    /\ toEnd \in [Sources -> Ends]
    /\ srv.st \in {"idle", "admitted", "sunk", "committed"}

\* Nothing is acknowledged that the ledger has not committed as stored or rejected.
AckSafe == \A a \in resps : \A q \in a.acks : q \in ledger[a.req.src].stored \cup ledger[a.req.src].rejected

\* Pending and exported payloads both require a committed seq.
SinkCommitted == \A r \in DurableRows : r.seq \in ledger[r.src].stored

\* A stored seq (including a drop record) always has a durable payload.
TruthfulLedger ==
    \A s \in Sources :
        /\ \A q \in ledger[s].stored : \E r \in DurableRows : Key(r) = <<s, q>>
        /\ \A q \in ledger[s].dropped : DurablyCovered(<<s, q>>)

\* Only the source's own Participant writes it: the row's owner is the Participant whose
\* credential sends the source, every stored or rejected seq is one the client minted for it,
\* and every sink row is a record the client made.
OwnerWrites ==
    /\ \A s \in Sources : ledger[s].owner \in {0, part[s]}
    /\ \A s \in Sources : \A q \in ledger[s].stored \cup ledger[s].rejected : \E r \in assigned : Key(r) = <<s, q>>
    /\ DurableRows \subseteq assigned

\* One record per key: copies of a write collapse, but two different records never share
\* (source_id, seq).
OneRecordPerKey == \A r1, r2 \in DurableRows : Key(r1) = Key(r2) => r1 = r2

\* The client never mints two records at one (source_id, seq), even across a reload.
SeqNeverReused == \A r1, r2 \in assigned : Key(r1) = Key(r2) => r1 = r2

\* Every durably enqueued record is still with the client, stored, or named by a stored drop
\* record. Otherwise its loss is one the server names, and it is in a gap.
DurableAccounted == \A r \in durable : Held(r) \/ r \in DurableRows \/ DurablyCovered(Key(r)) \/ (Excused(Key(r)) /\ InGap(r))

\* Every record the outbox accepted is accounted, a gap included.
Conservation == \A r \in assigned : Held(r) \/ r \in DurableRows \/ DurablyCovered(Key(r)) \/ InGap(r)

\* An exact missing range is never invented: every missing seq was really assigned.
GapsHonest == \A s \in Sources : \A q \in Missing(s) : \E r \in assigned : Key(r) = <<s, q>>

\* A closed source names its last seq exactly, so no record lies past it.
CloseHonest ==
    \A s \in Sources : ledger[s].end = "closed" => \A r \in assigned : r.src = s => r.seq < ledger[s].endNext

\* A close never hides committed history: nothing stored or rejected lies at or past it.
SuffixKept == \A s \in Sources : ledger[s].end = "closed" => ledger[s].endNext >= Past(ledger[s].stored \cup ledger[s].rejected)

\* A flood of routine records never pushes out a P0 record.
P0Reserved == ~p0OverLow

\* Under Fairness: every durable record ends up stored or named by a stored drop record,
\* unless its loss is one the server names, and every source before the live one has its end
\* on the server.
DurableDelivered == <>[](\A r \in durable : InSink(r) \/ Covered(Key(r)) \/ Excused(Key(r)))
EndsReported == <>[](\A s \in Sources : s < src => ledger[s].end # "")
=============================================================================
