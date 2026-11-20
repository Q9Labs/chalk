------------------------- MODULE TelemetryDelivery -------------------------
(***************************************************************************)
(* Delivery conservation for client telemetry (contract C3, see           *)
(* docs/telemetry-delivery.md).                                            *)
(*                                                                         *)
(* One device runs client sessions one after another: a boot is one page  *)
(* or app run, and each boot is one source with its own seq counter from   *)
(* 0. The outbox (sdks/typescript/client/src/telemetry/outbox.ts) holds    *)
(* every record in memory and keeps P0 records, the pending drop list and  *)
(* the high-water mark in a journal that survives a reload (journal.ts).   *)
(* After a reload the new boot sends what its predecessor left, under the  *)
(* predecessor's source, and says how that source ended.                   *)
(*                                                                         *)
(* The ingest route (apps/api/internal/httpapi/telemetry.go) writes the    *)
(* rows of a batch to the sink, then commits the source ledger             *)
(* (apps/api/internal/telemetrydelivery), then answers with the seqs it    *)
(* settled. The sink is a set: two writes of the same record are one row   *)
(* to the reader, which collapses copies by (source_id, seq).              *)
(*                                                                         *)
(* The model covers durably enqueued records (P0 and drop records) for the *)
(* strong rule, and every record the outbox accepted for accounting by     *)
(* gaps. It assumes every lane holds a credential the server accepts (the  *)
(* 24-hour telemetry token outlives delivery), that every boot's           *)
(* participant may write every source it names (one User or Agent, so the  *)
(* source bindings never bar it), and that the journal survives a reload.  *)
(* A guest reload breaks the binding assumption: the server settles the    *)
(* new boot's drop record for the old source as rejected and leaves that   *)
(* source's gap open, which the model does not cover. It does not model    *)
(* content rejection either (a rejected event writes a rejection row,      *)
(* which settles it like a stored one), the byte budget (eviction is a     *)
(* step, the reserve rule is checked), or a page restored from the         *)
(* back-forward cache after pagehide.                                      *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    MaxBoots,         \* client sessions on the device, so MaxBoots - 1 reloads
    MaxRecords,       \* records each boot makes, besides drop records
    Cap,              \* records the queue holds before it evicts (drop records are exempt)
    CheckCap,         \* FALSE in trace validation: the code evicts by bytes, not by count
    MaxFaults,        \* API crashes mid-batch, lost requests or answers, partial answers and
                      \* timeouts of a request still on its way, all together
    MayVanish,        \* the last boot may die and never come back
    Break             \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "ack_before_store",          \* the handler answers before the sink write and ledger commit
    "ledger_before_sink",        \* the handler commits the ledger before it writes the rows
    "dedupe_on_seq_only",        \* the ledger keys dedupe on seq, not on (source_id, seq)
    "reuse_source_on_reload",    \* a reloaded client keeps its source_id and counts seq from 0 again
    "evict_without_drop_record", \* the queue evicts without adding the seq to the drop list
    "volatile_drop_list",        \* the drop list lives in memory only, not in the journal
    "ack_whole_batch",           \* a 200 settles the whole batch, not only the seqs it names
    "no_p0_reserve",             \* eviction ignores priority, so routine records push out P0
    "abandoned_as_closed",       \* a successor reports a predecessor closed without its closing mark
    "ignore_journal_on_reload"   \* a reloaded client keeps the journal but never sends what it holds
}

ASSUME MaxBoots \in 1..3 /\ MaxRecords \in 1..8 /\ Cap \in 1..4 /\ MaxFaults \in 0..9
ASSUME CheckCap \in BOOLEAN /\ MayVanish \in BOOLEAN
ASSUME Break \in BreakNames

Sources == 1..MaxBoots
Keys == Sources \X Nat
Ends == {"", "abandoned", "closed"}

NoMsg == [src |-> 0, recs |-> {}, next |-> 0, end |-> "", boot |-> 0]
Idle == [st |-> "idle", m |-> NoMsg, settle |-> {}, new |-> {}]

VARIABLES
    boot,      \* the client session running now (1..MaxBoots)
    alive,     \* whether that session is running
    src,       \* the source it writes as: its own boot, unless a variant reuses one
    closed,    \* the session was disposed: its source takes no more records
    made,      \* records this boot made, besides drop records
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
    srv,       \* the batch the API is handling, if any
    assigned,  \* ghost: every record any boot made
    durable,   \* ghost: every record that was durably enqueued
    p0OverLow, \* ghost: a P0 record was evicted while a routine one was held
    faults     \* faults so far

clientVars == <<boot, alive, src, closed, made, next, mem, jrecs, jnext, jclosing, pdrops, toEnd, out>>
netVars == <<reqs, resps>>
serverVars == <<ledger, sink, srv>>
ghostVars == <<assigned, durable, p0OverLow>>
faultVars == <<faults>>
vars == <<clientVars, netVars, serverVars, ghostVars, faultVars>>

Key(r) == <<r.src, r.seq>>
Max(a, b) == IF a >= b THEN a ELSE b
IsDrop(r) == r.covers # {}
Counted(S) == {r \in S : ~IsDrop(r)}
Lane(s) == {r \in mem : r.src = s}

Init ==
    /\ boot = 1 /\ alive = TRUE /\ src = 1 /\ closed = FALSE /\ made = 0
    /\ next = [s \in Sources |-> 0]
    /\ mem = {} /\ jrecs = {}
    /\ jnext = [s \in Sources |-> 0]
    /\ jclosing = [s \in Sources |-> FALSE]
    /\ pdrops = {}
    /\ toEnd = [s \in Sources |-> ""]
    /\ out = [s \in Sources |-> NoMsg]
    /\ reqs = {} /\ resps = {}
    /\ ledger = [s \in Sources |-> [stored |-> {}, dropped |-> {}, reported |-> 0, end |-> "", endNext |-> 0]]
    /\ sink = {} /\ srv = Idle
    /\ assigned = {} /\ durable = {} /\ p0OverLow = FALSE
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
    /\ UNCHANGED <<boot, alive, src, closed, jclosing, pdrops, toEnd, out, netVars, serverVars, p0OverLow, faultVars>>

\* The queue gives up routine records first: a P0 record goes only when no routine one is left.
Victim(v) ==
    /\ v \in mem /\ ~IsDrop(v)
    /\ Break = "no_p0_reserve" \/ (v.p0 => \A u \in Counted(mem) : u.p0)

\* EventQueue eviction (and folding of stats windows, which evicts the older window).
\* The evicted key joins the drop list, which is saved with the journal.
Evict(v) ==
    /\ alive /\ ~closed
    /\ ~CheckCap \/ Cardinality(Counted(mem)) > Cap
    /\ Victim(v)
    /\ mem' = mem \ {v}
    /\ jrecs' = jrecs \ {v}
    /\ pdrops' = IF Break = "evict_without_drop_record" THEN pdrops ELSE pdrops \cup {Key(v)}
    /\ p0OverLow' = (p0OverLow \/ (v.p0 /\ \E u \in Counted(mem) : ~u.p0))
    /\ UNCHANGED <<boot, alive, src, closed, made, next, jnext, jclosing, toEnd, out, netVars, serverVars, assigned, durable, faultVars>>

\* A drain turns the drop list into a telemetry_dropped record of the current source, one
\* named source at a time (dropped_source_id names a predecessor). The outbox emits a drop
\* record only while no earlier one is unsettled, except as it disposes; the model lets it
\* emit at any time, which covers both. Drop records are never evicted.
EmitDrop ==
    /\ alive /\ ~closed /\ pdrops # {}
    /\ \E s \in {k[1] : k \in pdrops} :
         LET C == {k \in pdrops : k[1] = s}
             d == [src |-> src, seq |-> next[src], eid |-> boot, p0 |-> TRUE, covers |-> C]
         IN /\ mem' = mem \cup {d}
            /\ jrecs' = jrecs \cup {d}
            /\ assigned' = assigned \cup {d}
            /\ durable' = durable \cup {d}
            /\ pdrops' = pdrops \ C
    /\ jnext' = [jnext EXCEPT ![src] = next[src] + 1]
    /\ next' = [next EXCEPT ![src] = @ + 1]
    /\ UNCHANGED <<boot, alive, src, closed, made, jclosing, toEnd, out, netVars, serverVars, p0OverLow, faultVars>>

\* The throttled journal save that moves the high-water mark without a P0 record.
Checkpoint ==
    /\ alive /\ jnext[src] # next[src]
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ UNCHANGED <<boot, alive, src, closed, made, next, mem, jrecs, jclosing, pdrops, toEnd, out, netVars, serverVars, ghostVars, faultVars>>

\* One batch per source in flight, holding what the lane has (the code caps a batch at 100
\* events, which the bounds here never reach). A batch carries the source's high-water mark
\* (exact for the running source, the journal's for a predecessor) and the end the client
\* owes for it.
Send(s) ==
    /\ alive /\ out[s] = NoMsg
    /\ Lane(s) # {} \/ toEnd[s] # ""
    /\ LET m == [src |-> s, recs |-> Lane(s), next |-> IF s = src THEN next[s] ELSE jnext[s], end |-> toEnd[s], boot |-> boot]
       IN /\ reqs' = reqs \cup {m}
          /\ out' = [out EXCEPT ![s] = m]
    /\ UNCHANGED <<boot, alive, src, closed, made, next, mem, jrecs, jnext, jclosing, pdrops, toEnd, resps, serverVars, ghostVars, faultVars>>

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
    /\ UNCHANGED <<boot, alive, src, closed, made, next, mem, jrecs, jnext, jclosing, pdrops, toEnd, reqs, serverVars, ghostVars>>

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
    /\ UNCHANGED <<boot, alive, src, closed, made, next, jnext, jclosing, pdrops, reqs, serverVars, ghostVars, faultVars>>

\* Requests already sent still reach the API; their answers have no one to read them.
Die ==
    /\ alive' = FALSE /\ mem' = {} /\ out' = [s \in Sources |-> NoMsg] /\ resps' = {}
    /\ pdrops' = IF Break = "volatile_drop_list" THEN {} ELSE pdrops

\* The page or app dies without warning: memory is gone, the journal stays.
Crash ==
    /\ alive /\ (boot < MaxBoots \/ MayVanish)
    /\ Die
    /\ UNCHANGED <<boot, src, closed, made, next, jrecs, jnext, jclosing, toEnd, reqs, serverVars, ghostVars, faultVars>>

\* pagehide: the journal is saved with the exact high-water mark and the closing mark, then
\* the page goes (its last flush is an ordinary Send before this step).
PageHide ==
    /\ alive /\ ~closed /\ (boot < MaxBoots \/ MayVanish)
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ jclosing' = [jclosing EXCEPT ![src] = TRUE]
    /\ Die
    /\ UNCHANGED <<boot, src, closed, made, next, jrecs, toEnd, reqs, serverVars, ghostVars, faultVars>>

\* dispose(): no record follows, so the high-water mark is exact. The drop list is emitted first.
Dispose ==
    /\ alive /\ ~closed /\ pdrops = {}
    /\ closed' = TRUE
    /\ toEnd' = [toEnd EXCEPT ![src] = "closed"]
    /\ jnext' = [jnext EXCEPT ![src] = next[src]]
    /\ jclosing' = [jclosing EXCEPT ![src] = TRUE]
    /\ UNCHANGED <<boot, alive, src, made, next, mem, jrecs, pdrops, out, netVars, serverVars, ghostVars, faultVars>>

\* A reload: a new source, the predecessor's durable records and drop list taken over, and an
\* end owed for the predecessor: closed when it saved its closing mark, abandoned otherwise.
Reboot ==
    /\ ~alive /\ boot < MaxBoots
    /\ LET nb == boot + 1
           ns == IF Break = "reuse_source_on_reload" THEN src ELSE nb
           ended == IF jclosing[src] \/ Break = "abandoned_as_closed" THEN "closed" ELSE "abandoned"
       IN /\ boot' = nb
          /\ src' = ns
          /\ next' = [next EXCEPT ![ns] = 0]
          /\ toEnd' = IF ns # src THEN [toEnd EXCEPT ![src] = ended] ELSE toEnd
    /\ alive' = TRUE /\ closed' = FALSE /\ made' = 0
    /\ mem' = IF Break = "ignore_journal_on_reload" THEN {} ELSE jrecs
    /\ UNCHANGED <<jrecs, jnext, jclosing, pdrops, out, netVars, serverVars, ghostVars, faultVars>>

-----------------------------------------------------------------------------
(* The API: the ingest handler and the source ledger.                      *)

\* Dedupe is against stored seqs of the batch's own source. A seq a drop record covers is
\* still stored if its record arrives, so a late copy is not lost.
Fresh(r) ==
    IF Break = "dedupe_on_seq_only"
        THEN \A s \in Sources : r.seq \notin ledger[s].stored
        ELSE r.seq \notin ledger[r.src].stored

\* The handler takes one batch under the source's row lock. It settles all of it, except
\* when a fault makes the answer settle only some of it.
Receive(m, S) ==
    /\ srv.st = "idle" /\ m \in reqs
    /\ S \subseteq m.recs
    /\ IF S = m.recs THEN UNCHANGED faults ELSE faults < MaxFaults /\ faults' = faults + 1
    /\ reqs' = reqs \ {m}
    /\ srv' = [st |-> "admitted", m |-> m, settle |-> S, new |-> {r \in S : Fresh(r)}]
    /\ resps' = IF Break = "ack_before_store" THEN resps \cup {[req |-> m, acks |-> {r.seq : r \in S}]} ELSE resps
    /\ UNCHANGED <<clientVars, ledger, sink, ghostVars>>

\* The rows of new records (and drop records) go to the sink.
Write ==
    /\ srv.st = IF Break = "ledger_before_sink" THEN "ledgered" ELSE "admitted"
    /\ sink' = sink \cup srv.new
    /\ srv' = [srv EXCEPT !.st = IF Break = "ledger_before_sink" THEN "committed" ELSE "written"]
    /\ UNCHANGED <<clientVars, netVars, ledger, ghostVars, faultVars>>

Applied(s, m, n) ==
    LET L == ledger[s]
        own == s = m.src
        ending == own /\ m.end # "" /\ L.end # "closed"
    IN [stored |-> IF own THEN L.stored \cup {r.seq : r \in n} ELSE L.stored,
        dropped |-> L.dropped \cup {k[2] : k \in {k \in UNION {d.covers : d \in n} : k[1] = s}},
        reported |-> IF own THEN Max(L.reported, m.next) ELSE L.reported,
        end |-> IF ending THEN m.end ELSE L.end,
        endNext |-> IF ending THEN m.next ELSE L.endNext]

\* One ledger transaction: stored seqs, seqs the new drop records cover, the high-water mark
\* and the end.
Commit ==
    /\ srv.st = IF Break = "ledger_before_sink" THEN "admitted" ELSE "written"
    /\ ledger' = [s \in Sources |-> Applied(s, srv.m, srv.new)]
    /\ srv' = [srv EXCEPT !.st = IF Break = "ledger_before_sink" THEN "ledgered" ELSE "committed"]
    /\ UNCHANGED <<clientVars, netVars, sink, ghostVars, faultVars>>

Respond ==
    /\ srv.st = "committed"
    /\ resps' = IF Break = "ack_before_store" THEN resps ELSE resps \cup {[req |-> srv.m, acks |-> {r.seq : r \in srv.settle}]}
    /\ srv' = Idle
    /\ UNCHANGED <<clientVars, reqs, ledger, sink, ghostVars, faultVars>>

\* The API dies mid-batch: rows written stay, an uncommitted ledger change is gone.
ServerCrash ==
    /\ srv.st # "idle" /\ faults < MaxFaults
    /\ srv' = Idle /\ faults' = faults + 1
    /\ UNCHANGED <<clientVars, netVars, ledger, sink, ghostVars>>

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
    \/ EmitDrop
    \/ Checkpoint
    \/ \E s \in Sources : Send(s)
    \/ \E s \in Sources : Timeout(s)
    \/ \E a \in resps : Ack(a)
    \/ Crash \/ PageHide \/ Dispose \/ Reboot
    \/ \E m \in reqs : \E S \in SUBSET m.recs : Receive(m, S)
    \/ Write \/ Commit \/ Respond \/ ServerCrash
    \/ \E m \in reqs : LoseRequest(m)
    \/ \E a \in resps : LoseAnswer(a)

\* Progress assumptions for eventual accounting, and nothing more: the client sends what it
\* holds, times out a lost request, reads answers and comes back after a crash; the API
\* handles what reaches it. Faults are bounded by the constants.
Fairness ==
    /\ \A s \in Sources : WF_vars(Send(s))
    /\ \A s \in Sources : WF_vars(alive /\ out[s] # NoMsg /\ Lost(out[s]) /\ Timeout(s))
    /\ WF_vars(\E a \in resps : Ack(a))
    /\ WF_vars(EmitDrop)
    /\ WF_vars(Reboot)
    /\ WF_vars(\E m \in reqs : Receive(m, m.recs))
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

\* The evidence_gap computation (telemetrydelivery.Gaps): below the high-water mark every
\* seq that is neither stored nor dropped is missing; past it, the tail is unknown unless the
\* source closed.
High(s) == IF ledger[s].end = "closed" THEN ledger[s].endNext ELSE Max(ledger[s].reported, ledger[s].endNext)
Missing(s) == {q \in 0..(High(s) - 1) : q \notin ledger[s].stored \cup ledger[s].dropped}
TailUnknown(s) == ledger[s].end # "closed"
InGap(r) == r.seq \in Missing(r.src) \/ (TailUnknown(r.src) /\ r.seq >= High(r.src))

TypeOK ==
    /\ boot \in Sources /\ src \in Sources /\ alive \in BOOLEAN /\ closed \in BOOLEAN
    /\ next \in [Sources -> Nat] /\ jnext \in [Sources -> Nat]
    /\ pdrops \subseteq Keys
    /\ toEnd \in [Sources -> Ends]
    /\ srv.st \in {"idle", "admitted", "written", "ledgered", "committed"}

\* Nothing is acknowledged that the ledger has not committed as stored.
AckSafe == \A a \in resps : \A q \in a.acks : q \in ledger[a.req.src].stored

\* The ledger claims only what the sink holds: a stored seq has its row, a dropped seq is
\* named by a stored drop record.
TruthfulLedger ==
    \A s \in Sources :
        /\ \A q \in ledger[s].stored : \E r \in sink : Key(r) = <<s, q>>
        /\ \A q \in ledger[s].dropped : Covered(<<s, q>>)

\* One record per key: copies of a write collapse, but two different records never share
\* (source_id, seq).
OneRecordPerKey == \A r1, r2 \in sink : Key(r1) = Key(r2) => r1 = r2

\* Every durably enqueued record is still with the client, stored, or named by a stored drop
\* record. A gap never stands in for one.
DurableAccounted == \A r \in durable : Held(r) \/ InSink(r) \/ Covered(Key(r))

\* Every record the outbox accepted is accounted, a gap included.
Conservation == \A r \in assigned : Held(r) \/ InSink(r) \/ Covered(Key(r)) \/ InGap(r)

\* An exact missing range is never invented: every missing seq was really assigned.
GapsHonest == \A s \in Sources : \A q \in Missing(s) : \E r \in assigned : Key(r) = <<s, q>>

\* A closed source names its last seq exactly, so no record lies past it.
CloseHonest ==
    \A s \in Sources : ledger[s].end = "closed" => \A r \in assigned : r.src = s => r.seq < ledger[s].endNext

\* A flood of routine records never pushes out a P0 record.
P0Reserved == ~p0OverLow

\* Under Fairness: every durable record ends up stored or named by a stored drop record,
\* and every predecessor source has its end on the server.
DurableDelivered == <>[](\A r \in durable : InSink(r) \/ Covered(Key(r)))
EndsReported == <>[](\A s \in Sources : s < src => ledger[s].end # "")
=============================================================================
