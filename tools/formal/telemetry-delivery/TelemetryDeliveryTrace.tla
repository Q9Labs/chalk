----------------------- MODULE TelemetryDeliveryTrace -----------------------
(***************************************************************************)
(* Trace validation: TLC replays one trace that a real outbox integration *)
(* test recorded (outbox.delivery.test.ts) and checks that every line is a *)
(* step of TelemetryDelivery. `trace.mjs` turns the test's NDJSON into     *)
(* TraceData.tla and maps the real ids to model ids.                       *)
(*                                                                         *)
(* A trace the model cannot replay shows the code and the model disagree.  *)
(* A trace it replays proves only that this run was a run of the model,    *)
(* not that the code refines it.                                           *)
(***************************************************************************)
EXTENDS TelemetryDelivery, Sequences, TraceData

CONSTANT Upto  \* run.sh asks whether some replay takes the first Upto lines

VARIABLE l     \* the next trace line to replay

SeqsOf(B) == {r.seq : r \in B}

Step(t) ==
    \/ /\ t.a = "record"
       /\ src = t.src /\ next[src] = t.seq
       /\ Record(t.p0)
    \/ /\ t.a = "evict"
       /\ \E v \in mem : Key(v) = <<t.src, t.seq>> /\ Evict(v)
    \/ /\ t.a = "emit_drop"
       /\ Mark(t.src) = t.seq
       /\ EmitDrop(t.src)
       /\ \E d \in mem' : d.src = t.src /\ d.seq = t.seq /\ d.covers = t.covers
    \/ /\ t.a = "checkpoint"
       /\ src = t.src /\ next[src] = t.next
       /\ \/ Checkpoint
          \/ jnext[src] = next[src] /\ UNCHANGED vars
    \/ /\ t.a = "send"
       /\ Send(t.src)
       /\ SeqsOf(out'[t.src].recs) = t.seqs
       /\ out'[t.src].next = t.next
       /\ out'[t.src].end = t.end
    \/ /\ t.a = "timeout"
       /\ Timeout(t.src)
    \/ /\ t.a = "ack"
       /\ \E a \in resps : a.req.src = t.src /\ a.acks = t.acks /\ Ack(a)
    \/ t.a = "crash" /\ Crash
    \/ t.a = "pagehide" /\ PageHide
    \/ t.a = "dispose" /\ src = t.src /\ Dispose
    \/ t.a = "reboot" /\ Reboot /\ src' = t.src
    \/ t.a = "rejoin" /\ src = t.src /\ Rejoin /\ src' = t.next
    \/ /\ t.a = "receive"
       /\ \E m \in reqs :
            /\ m.src = t.src /\ SeqsOf(m.recs) = t.seqs
            /\ \E S \in SUBSET m.recs : SeqsOf(S) = t.settle /\ Receive(m, S, {})
    \/ /\ t.a = "refuse"
       /\ \E m \in reqs : m.src = t.src /\ SeqsOf(m.recs) = t.seqs /\ Refuse(m)
    \/ t.a = "commit" /\ Commit
    \/ t.a = "write" /\ Write
    \/ t.a = "respond" /\ Respond
    \/ t.a = "server_crash" /\ ServerCrash
    \/ /\ t.a = "lose_request"
       /\ \E m \in reqs : m.src = t.src /\ SeqsOf(m.recs) = t.seqs /\ LoseRequest(m)
    \/ /\ t.a = "lose_answer"
       /\ \E a \in resps : a.req.src = t.src /\ LoseAnswer(a)

TraceInit == Init /\ l = 1
TraceNext == l <= Len(Trace) /\ Step(Trace[l]) /\ l' = l + 1
TraceSpec == TraceInit /\ [][TraceNext]_<<vars, l>>

\* TLC reports this broken exactly when some replay takes the first Upto lines.
Reached == l <= Upto
=============================================================================
