------------------------- MODULE ScreenShareLease -------------------------
(***************************************************************************)
(* The screen-share lease of one Chalk Episode: the Postgres row in        *)
(* sync_screen_share_leases and the Live.Episode process that acquires,    *)
(* renews and releases it while it follows the media plane's observations. *)
(*                                                                         *)
(* Paths are relative to apps/sync/lib/chalk_sync/live/. Time is counted   *)
(* in units of 5 seconds: the renewal window is 10 s (Renew = 2), the hard *)
(* cap is 30 s but modeled as 25 s (Hard = 5, to keep the state space      *)
(* small) and the coordinator reconciles every 15 s (Every = 3,            *)
(* `@live_reconcile_interval_ms` in episodes/coordinator.ex).              *)
(*                                                                         *)
(* Break selects one broken variant of the code. "none" is the real code.  *)
(* Each other value names the code edit it mirrors, and `run.sh` proves    *)
(* that each one breaks the rule it guards (see `breaks`).                 *)
(***************************************************************************)
EXTENDS Naturals, Integers, FiniteSets

CONSTANTS
    People,   \* exactly two participants
    MaxGen,   \* highest participant generation a person reaches
    Horizon,  \* last time unit
    Renew,    \* renewal window, @default_renewal_ms
    Hard,     \* hard cap, @default_hard_lifetime_ms
    Every,    \* the coordinator's reconcile interval, @live_reconcile_interval_ms
    MaxSeq,   \* highest media observation cursor the plane reaches
    MaxLid,   \* most lease takeovers (a bound on the lease ids)
    Break     \* "none" or one broken variant, see BreakNames

BreakNames == {
    "none",
    "stale_observation_applies",  \* compare_media_cursor no longer ignores an :older cursor
    "renew_skips_authority",      \* reconcile_observed_screen_lease renews without the authority check
    "takeover_ignores_expiry"     \* acquire_query's `where least(...) <= excluded.acquired_at` is dropped
}

ASSUME Cardinality(People) = 2
ASSUME Break \in BreakNames

Ord == CHOOSE s \in [1..2 -> People] : s[1] # s[2]
Min(a, b) == IF a < b THEN a ELSE b
Max(a, b) == IF a > b THEN a ELSE b

VARIABLES
    now,      \* the clock
    since,    \* time units since the last observation was applied or looked at
    auth,     \* each person's authorised generation, 0 when not in the call
    gens,     \* the last generation each person was issued
    pub,      \* people with a screen publication at the media plane
    seq,      \* the plane's newest observation cursor
    hist,     \* the publications each cursor reported
    mc,       \* the cursor Live.Episode applied last, -1 before the first
    top,      \* the newest cursor Live.Episode ever applied (history)
    mitems,   \* the screen publications Live.Episode last applied
    mem,      \* Live.Episode's `screen_leases`: the lease each person holds in memory
    db,       \* the sync_screen_share_leases row
    lidc,     \* how many leases were created (lease ids)
    stolen,   \* a live lease was taken over by another owner (history)
    authBad,  \* a lease was acquired or renewed for a generation that is not authorised (history)
    freshBad  \* a new share got a lease with less than a full hard cap (history)

vars == <<now, since, auth, gens, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

NoLease == [lid |-> 0, gen |-> 0]

TypeOK ==
    /\ now \in 0..Horizon
    /\ since \in 0..Every
    /\ auth \in [People -> 0..MaxGen]
    /\ gens \in [People -> 0..MaxGen]
    /\ pub \subseteq People
    /\ seq \in 0..MaxSeq
    /\ hist \in [0..MaxSeq -> SUBSET People]
    /\ mc \in -1..MaxSeq
    /\ top \in -1..MaxSeq
    /\ mitems \subseteq People
    /\ mem \in [People -> [lid : 0..MaxLid, gen : 0..MaxGen]]
    /\ db \in [held : BOOLEAN, owner : People, gen : 0..MaxGen, lid : 0..MaxLid,
               ru : 0..(Horizon + Renew), hu : 0..(Horizon + Hard)]
    /\ lidc \in 0..MaxLid
    /\ stolen \in BOOLEAN /\ authBad \in BOOLEAN /\ freshBad \in BOOLEAN

Init ==
    /\ now = 0
    /\ since = 0
    /\ auth = [p \in People |-> 0]
    /\ gens = [p \in People |-> 0]
    /\ pub = {}
    /\ seq = 0
    /\ hist = [c \in 0..MaxSeq |-> {}]
    /\ mc = -1
    /\ top = -1
    /\ mitems = {}
    /\ mem = [p \in People |-> NoLease]
    /\ db = [held |-> FALSE, owner |-> Ord[1], gen |-> 0, lid |-> 0, ru |-> 0, hu |-> 0]
    /\ lidc = 0
    /\ stolen = FALSE /\ authBad = FALSE /\ freshBad = FALSE

-----------------------------------------------------------------------------
(* The lease row                                                           *)

(* A lease is live while `least(renewed_until, hard_expires_at) > now`.    *)
Live(r) == r.held /\ Min(r.ru, r.hu) > now

(* A working copy of what one Live.Episode step changes. The row, the      *)
(* lease ids and the history flags are shared state in Postgres, so they   *)
(* stay changed when the step later fails; `mem` changes only on success.  *)
S0 == [db |-> db, mem |-> mem, lidc |-> lidc, err |-> FALSE,
       stolen |-> stolen, authBad |-> authBad]

(* ScreenShareLease.acquire (acquire_query): an upsert on                  *)
(* (tenant, episode). The same owner and generation, with a live lease,    *)
(* keeps the lease id and the hard cap and extends the renewal window up   *)
(* to the hard cap. Any other caller gets the row only when the lease      *)
(* is no longer live.                                                      *)
Acquire(st, p, g) ==
    LET r == st.db
        same == r.held /\ r.owner = p /\ r.gen = g /\ Live(r)
        free == ~Live(r) \/ Break = "takeover_ignores_expiry"
        bad == st.authBad \/ auth[p] # g
    IN IF same
       THEN [ok |-> TRUE,
             st |-> [st EXCEPT !.db.ru = Max(r.ru, Min(r.hu, now + Renew)),
                               !.mem[p] = [lid |-> r.lid, gen |-> g],
                               !.authBad = bad]]
       ELSE IF free /\ st.lidc < MaxLid
       THEN [ok |-> TRUE,
             st |-> [st EXCEPT !.db = [held |-> TRUE, owner |-> p, gen |-> g, lid |-> st.lidc + 1,
                                       ru |-> now + Renew, hu |-> now + Hard],
                               !.lidc = st.lidc + 1,
                               !.mem[p] = [lid |-> st.lidc + 1, gen |-> g],
                               !.stolen = st.stolen \/ (Live(r) /\ r.owner # p),
                               !.authBad = bad]]
       ELSE [ok |-> FALSE, st |-> st]

(* ScreenShareLease.release deletes the row that carries the caller's      *)
(* lease id, lease generation and owner. Live.Episode ignores the result   *)
(* (`_ = release_screen_lease(...)`, episode.ex) and forgets the lease, so *)
(* a release that fails with :dependency_unavailable (1 s query timeout)   *)
(* leaves the row in place.                                                *)
Rel(st, p, ok) ==
    LET m == st.mem[p]
        r == st.db
        hit == ok /\ r.held /\ r.owner = p /\ r.gen = m.gen /\ r.lid = m.lid
    IN [st EXCEPT !.mem[p] = NoLease, !.db.held = IF hit THEN FALSE ELSE r.held]

-----------------------------------------------------------------------------
(* The media plane                                                         *)

Bump(newPub) ==
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ hist' = [hist EXCEPT ![seq + 1] = newPub]
    /\ pub' = newPub

-----------------------------------------------------------------------------
(* People                                                                  *)

(* Time passes only once Live.Episode has applied the plane's newest      *)
(* observation: delivery takes less than one unit (5 s). A slower          *)
(* delivery is left out.                                                   *)
Tick ==
    /\ now < Horizon
    /\ mc = seq
    /\ since < Every
    /\ now' = now + 1
    /\ since' = since + 1
    /\ UNCHANGED <<auth, gens, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

Join(p) ==
    /\ auth[p] = 0
    /\ gens[p] < MaxGen
    /\ gens' = [gens EXCEPT ![p] = @ + 1]
    /\ auth' = [auth EXCEPT ![p] = gens[p] + 1]
    /\ UNCHANGED <<now, since, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

(* The participant leaves: the authority ends at once. The plane drops    *)
(* the publication later (ClientStops); the Leave path never touches the   *)
(* lease.                                                                  *)
Leave(p) ==
    /\ auth[p] > 0
    /\ auth' = [auth EXCEPT ![p] = 0]
    /\ UNCHANGED <<now, since, gens, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

(* The participant stops capturing; the plane drops the publication.       *)
ClientStops(p) ==
    /\ p \in pub
    /\ Bump(pub \ {p})
    /\ UNCHANGED <<now, since, auth, gens, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

(* The live command set_screen_share_enabled = true                        *)
(* (enable_reserved_publication for :screen): acquire the lease, then      *)
(* grant the publication. A grant that fails terminally releases the lease *)
(* again. When Live.Episode already sees the share, the grant is           *)
(* skipped (:satisfied). A client asks only while it has no publication.   *)
EnableScreen(p, grantOk, relOk) ==
    /\ auth[p] > 0
    /\ p \notin pub
    /\ LET a == Acquire(S0, p, auth[p])
           fresh == mem[p].lid = 0
           fb == freshBad \/ (fresh /\ a.st.db.hu # now + Hard)
       IN /\ a.ok
          /\ IF p \in mitems
             THEN /\ db' = a.st.db /\ mem' = a.st.mem
                  /\ UNCHANGED <<pub, seq, hist>>
             ELSE IF grantOk
             THEN /\ db' = a.st.db /\ mem' = a.st.mem
                  /\ Bump(pub \cup {p})
             ELSE LET z == Rel(a.st, p, relOk)
                  IN /\ db' = z.db /\ mem' = z.mem
                     /\ UNCHANGED <<pub, seq, hist>>
          /\ lidc' = a.st.lidc /\ stolen' = a.st.stolen /\ authBad' = a.st.authBad
          /\ freshBad' = fb
    /\ UNCHANGED <<now, since, auth, gens, mc, top, mitems>>

(* The live command set_screen_share_enabled = false                       *)
(* (maybe_release_screen_lease): release the lease and forget it. The      *)
(* model runs it only after the plane dropped the publication; pausing a   *)
(* track that is still published is outside the model.                     *)
StopCommand(p, relOk) ==
    /\ auth[p] > 0
    /\ p \notin pub
    /\ mem[p].lid # 0
    /\ LET z == Rel(S0, p, relOk)
       IN db' = z.db /\ mem' = z.mem
    /\ UNCHANGED <<now, since, auth, gens, pub, seq, hist, mc, top, mitems, lidc, stolen, authBad, freshBad>>

-----------------------------------------------------------------------------
(* Live.Episode follows the media plane                                    *)

(* reconcile_observed_screen_lease: for a person whose share the           *)
(* observation shows, the authority must still be the lease's generation;  *)
(* then ScreenShareLease.renew needs a live lease, and a lapsed one is     *)
(* rotated with a fresh acquire. A person the observation no longer shows  *)
(* releases the lease. An error halts the whole pass.                      *)
Handle(st, p, items, rf) ==
    LET m == st.mem[p]
        r == st.db
        renewable == r.held /\ r.owner = p /\ r.gen = m.gen /\ r.lid = m.lid /\ Live(r)
    IN IF st.err \/ m.lid = 0 THEN st
       ELSE IF p \notin items THEN Rel(st, p, rf)
       ELSE IF auth[p] # m.gen /\ Break # "renew_skips_authority" THEN Rel(st, p, rf)
       ELSE IF renewable
            THEN [st EXCEPT !.db.ru = Min(r.hu, now + Renew), !.authBad = st.authBad \/ auth[p] # m.gen]
            ELSE LET a == Acquire(st, p, m.gen)
                 IN IF a.ok THEN a.st ELSE [st EXCEPT !.err = TRUE]

(* acquire_observed_screen_lease: a share without a lease in memory.       *)
Observed(st, items) ==
    IF st.err \/ Cardinality(items) # 1 THEN st
    ELSE LET q == CHOOSE x \in items : TRUE
         IN IF st.mem[q].lid # 0 THEN st
            ELSE IF auth[q] = 0 THEN [st EXCEPT !.err = TRUE]
            ELSE LET a == Acquire(st, q, auth[q])
                 IN IF a.ok THEN a.st ELSE [st EXCEPT !.err = TRUE]

(* apply_newer_media_observation runs the pass over the people and then   *)
(* the observed share. An error halts the pass before `mem` and the        *)
(* cursor change; the row and the history flags stay changed.              *)
Pass(c, rf) ==
    LET items == hist[c]
    IN Observed(Handle(Handle(S0, Ord[1], items, rf), Ord[2], items, rf), items)

(* apply_media_observation compares {incarnation, sequence}: an older      *)
(* cursor is ignored, an equal one only re-projects the same snapshot (it  *)
(* never touches a lease), and a newer one reconciles the leases. A late   *)
(* delivery can repeat or reorder snapshots Live.Episode already saw, but  *)
(* a new snapshot always is the plane's newest (c = seq): skipping ahead   *)
(* to an older one is left out. The coordinator also forces a look every   *)
(* `Every` units.                                                          *)
Applies(c) == c > mc \/ (c < mc /\ Break = "stale_observation_applies")

Fresh(c) == c = seq \/ c <= mc

Observe(c, rf) ==
    /\ Applies(c)
    /\ Fresh(c)
    /\ Cardinality(hist[c]) < 2
    /\ since' = 0
    /\ db' = Pass(c, rf).db
    /\ lidc' = Pass(c, rf).lidc
    /\ stolen' = Pass(c, rf).stolen
    /\ authBad' = Pass(c, rf).authBad
    /\ mem' = IF Pass(c, rf).err THEN mem ELSE Pass(c, rf).mem
    /\ mc' = IF Pass(c, rf).err THEN mc ELSE c
    /\ top' = IF Pass(c, rf).err THEN top ELSE Max(top, c)
    /\ mitems' = IF Pass(c, rf).err THEN mitems ELSE hist[c]
    /\ UNCHANGED <<now, auth, gens, pub, seq, hist, freshBad>>

(* More than one screen publication stops the pass before anything else    *)
(* (:conflicting_screen_publications).                                     *)
Conflict(c) ==
    /\ Applies(c)
    /\ Fresh(c)
    /\ Cardinality(hist[c]) >= 2
    /\ since' = 0
    /\ UNCHANGED <<now, auth, gens, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

Look(c) ==
    /\ ~Applies(c)
    /\ since' = 0
    /\ UNCHANGED <<now, auth, gens, pub, seq, hist, mc, top, mitems, mem, db, lidc, stolen, authBad, freshBad>>

Next ==
    \/ Tick
    \/ \E p \in People : Join(p) \/ Leave(p) \/ ClientStops(p)
    \/ \E p \in People : \E g, r \in BOOLEAN : EnableScreen(p, g, r)
    \/ \E p \in People : \E r \in BOOLEAN : StopCommand(p, r)
    \/ \E c \in 0..MaxSeq, rf \in BOOLEAN : Observe(c, rf)
    \/ \E c \in 0..MaxSeq : Conflict(c) \/ Look(c)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Rules                                                                   *)

(* A lease that is live is never taken by another owner.                   *)
NoTakeoverWhileLive == ~stolen

(* A lease is acquired or renewed only for the participant generation that *)
(* is authorised at that moment.                                           *)
LeaseNeedsAuthority == ~authBad

(* Live.Episode's projection is the newest observation it ever applied.    *)
NewestObservationWins == mc = top

(* At most one participant in the call has a screen publication. A        *)
(* publication of someone who left stays until the plane drops it and      *)
(* does not count.                                                         *)
AtMostOneShare == Cardinality({p \in pub : auth[p] > 0}) <= 1

(* A new share gets a lease with a full hard cap, so a person whose share  *)
(* ended can share again without inheriting the old cap.                   *)
ReshareGetsFullLease == ~freshBad

=============================================================================
