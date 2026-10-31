---------------------------- MODULE Sfu ----------------------------
(***************************************************************************)
(* The SFU-side behavior of the media control model. This is the only      *)
(* module that knows what an SFU is. MediaControl.tla calls these          *)
(* operators and nothing else, so swapping the SFU means changing the      *)
(* three constants below, or replacing this file.                          *)
(*                                                                         *)
(* A publication is a record [src, sess]: source `src` is published        *)
(* in the device's SFU session `sess`. `pubs` is the SFU publication       *)
(* ledger: in Cloudflare it is the Go API ledger in front of the SFU.      *)
(*                                                                         *)
(*   Cloudflare today   CloseCanFail = TRUE   OrphansLinger = TRUE         *)
(*                      AtomicRevoke = FALSE                               *)
(*   Own SFU, state     CloseCanFail = FALSE  OrphansLinger = FALSE        *)
(*   in the room                                                           *)
(*   authority          AtomicRevoke = TRUE                                *)
(***************************************************************************)
CONSTANTS
  CloseCanFail,   \* a separate close call can fail (Cloudflare tracks/close)
  OrphansLinger,  \* publications of a dead session stay until closed or garbage-collected
  AtomicRevoke    \* revoking a grant removes the publication in the same step

Pub(s, sess) == [src |-> s, sess |-> sess]

\* Publication admitted. The caller has already checked the grant.
Admit(pubs, s, sess) == pubs \cup {Pub(s, sess)}

\* Sync revokes a grant (device off, host mute): what the SFU does in that step.
OnRevoke(pubs, s) == IF AtomicRevoke THEN {p \in pubs : p.src # s} ELSE pubs

\* The device's SFU session dies (PeerConnection lost, rebuilt later).
OnSessionLost(pubs) == IF OrphansLinger THEN pubs ELSE {}

\* Publications the SFU may garbage-collect on its own (no packets, dead session).
Collectable(pubs, cur, up) ==
  IF OrphansLinger THEN {p \in pubs : p.sess # cur \/ ~up} ELSE {}

\* Publications Sync must close with a separate call after a revoke.
Closable(pubs, granted) == {p \in pubs : ~granted[p.src]}
=======================================================================
