# Telemetry delivery

This is contract C3 of the observability foundation. It says how a client record gets from the SDK to the server exactly once, how the server acknowledges it, and what the server can claim when a record never arrives. The rule it guards is **delivery conservation**: every durably enqueued record is stored once, or named by a stored drop record. A source that vanishes without a persisted high-water mark leaves an `evidence_gap` with an unknown tail, never an invented exact range.

The model that checks the rule is [TelemetryDelivery.tla](../tools/formal/telemetry-delivery/TelemetryDelivery.tla). The reference code is the SDK outbox (`sdks/typescript/client/src/telemetry/`), the ingest route (`apps/api/internal/httpapi/telemetry.go`) and the source ledger (`apps/api/internal/telemetrydelivery`). [Observability](observability.md#client-telemetry) covers what the rows mean.

## Names

These names are shared with C1 (IDs and envelope) and C2+C4 (witnesses and output). Use them exactly.

| Name | What it is | Minted by |
|---|---|---|
| `source_id` | The stream a record belongs to. For the SDK it is the client session (`cs_` in display): one run of one SDK client, from boot through disposal. A reload is a new source. | client, a UUID at boot |
| `seq` | The record's position in its source: 0, 1, 2 and so on with no reuse. `(source_id, seq)` is the record's identity and the dedupe key. | client, at record time |
| `event_id` | A UUID per record, minted with its `seq`. It is the evidence handle (`ev_` in display), and a reader that sees two `event_id`s for one `(source_id, seq)` has found a bug. | client, at record time |
| `batch_id` | A UUID per batch. A batch never changes while it is in flight, and a retry resends it with the same `batch_id`. | client, when it forms the batch |
| `next_seq` | The source's high-water mark: every seq below it has been assigned. | client, on every batch |
| `end` | How a source ended: `closed` (the client said its last `next_seq` exactly) or `abandoned` (a successor found it dead and reports the last high-water mark it persisted). | client |
| `SourceWatermark` | What the server knows of a source: its high-water mark, its end and which seqs are stored, rejected or dropped. | server ledger |
| `EvidenceGap` | A seq range the server cannot account for, with its cause. | server, computed from the ledger |

## The wire

`POST /v1/tenants/{tenant_id}/telemetry`, body at most 64 KiB:

```json
{
  "version": 2,
  "source_id": "0b7c…",
  "batch_id": "5d1e…",
  "next_seq": 42,
  "end": "abandoned",
  "events": [
    { "event_id": "9a4f…", "seq": 40, "elapsed_ms": 81234, "type": "call_ended", "…": "…" },
    { "event_id": "c2d8…", "seq": 41, "elapsed_ms": 81240, "type": "telemetry_dropped",
      "dropped": 3, "drop_reason": "queue_full", "dropped_seqs": [{ "from": 12, "to": 15 }] }
  ]
}
```

- `events` holds 0 to 100 records. An empty batch is allowed only when it carries `end`.
- A drop record is a `telemetry_dropped` event. `dropped_seqs` lists half-open ranges `[from, to)`, at most 64. `dropped_source_id` names a predecessor source when the dropped seqs are not this source's. `drop_reason` is `queue_full`, `credential_expired` or `refused`. The ranges name records the client gave up on; the record itself is P0 and never evicted.
- Version 1 bodies (`{ version: 1, client_session_id, events }`) from SDKs that predate this contract are still accepted. They are logged as before and never touch the ledger, so they get no acknowledgment and no gaps.

The answer to a version 2 batch:

```json
{ "accepted": 1, "rejected": 1, "duplicates": 0,
  "acks": [{ "from": 40, "to": 42 }],
  "rejections": [{ "seq": 41, "reason": "range" }] }
```

- `acks` names every seq of the batch that is **settled**: stored now, stored before (a duplicate), or rejected for its content. A rejected record is logged as `sdk.telemetry.rejected` with its reason and is final; sending it again changes nothing.
- A seq of the batch that `acks` does not name is unsettled. The client keeps it and sends it again. The server answers this way when it settles only part of a batch.
- Status codes settle nothing: 400 and 413 mean the frame is wrong, so the client drops the batch and records the drop with reason `refused`. 401 means refresh the credential, or drop with `credential_expired` when the subject has no fresh one. 429, 5xx, a timeout and a network error mean send the same batch again after backoff. When the ledger is down the API answers 503 with `Retry-After` and writes nothing.

## The client

1. **Stamping.** `record()` gives the record its `source_id`, the next `seq` and a new `event_id`, and queues it.
2. **Priority.** Each event type has a class in one exhaustive table: `p0` for the records that explain why a call failed or ended (`call_ended`, `connection_failed`, `render_crashed`, `problem_reported`, `telemetry_dropped`, the space join span, recovery exhaustion, access refresh failure, device failure and unconfirmed cleanup), `stats` for `call_stats`, and `routine` for the rest.
3. **Reservation.** Routine and stats records may fill at most half of the queue's byte budget, and they never push out a P0 record. When the queue is full it gives up stats first (folding two windows into one keeps the newer and drops the older), then routine records, oldest first, and a P0 record only when nothing else is left. Every record it gives up joins the **drop list**.
4. **Drop records.** The next drain turns the drop list into one `telemetry_dropped` record of the current source, sent like any P0 record. A drop record is never evicted. While an earlier drop record is unsettled the list waits, so a long outage grows the list rather than the queue.
5. **Batches.** A batch takes up to 100 records of one subject, at most 48 KiB, and gets a `batch_id`. It is immutable until its answer arrives. One batch per source is in flight at a time.
6. **Settling.** The client removes exactly the seqs `acks` names and keeps the rest.
7. **The journal.** On the web the outbox keeps a journal in `sessionStorage` (`TelemetryJournal` in the platform), which a reload of the same tab can read and other tabs cannot. It holds, per source, the P0 records not yet settled, the drop list, the high-water mark, the end the client still owes and the credential of each subject. A P0 record is written to the journal before `record()` returns, so P0 means **durably enqueued**. The high-water mark is saved at most every 5 seconds, and exactly on `pagehide`, with a closing mark.
8. **Reload.** A new boot is a new source. It reads its predecessors' journals, sends their records under the predecessor's `source_id` and credential, and sends each predecessor's end: `closed` with the exact `next_seq` when the predecessor saved its closing mark, otherwise `abandoned` with the last `next_seq` it persisted.
9. **Disposal.** `dispose()` turns the whole drop list into drop records, even past an unsettled one, because no later drain will. It sends what it holds, then sends `end: "closed"` with the exact `next_seq`. What stays unsettled stays in the journal, and the next client in the tab sends it.

React Native has no journal yet, so an app kill leaves an unknown tail there. A slice adds one through the same `TelemetryJournal` port.

## The server

The handler does this for one batch, under a row lock on the source's ledger (`SELECT … FOR UPDATE`):

1. Decode the frame and mark each record accepted or rejected for its content.
2. Bind every source the batch touches to its participant when the source has no binding yet. Refuse the batch when its own source is bound to a participant this one may not write, and bar every predecessor bound that way (see below).
3. Find the new seqs: those not already stored or rejected for this `(tenant, source, participant)`. A new drop record that names a barred predecessor is rejected with the reason `source_bound`.
4. Write one row per new accepted record to the sink (`sdk.telemetry`) and one per new rejected record (`sdk.telemetry.rejected`).
5. Commit the ledger: the bindings, the stored, rejected and dropped ranges, the reported high-water mark, the end and the receive times.
6. Answer with `acks`.

The answer comes only after the commit, so an acknowledged seq is always stored. A crash between the sink write and the commit leaves rows the ledger does not name; the retry writes them again with the same `event_id`, and the reader collapses copies by `(source_id, seq)`. That is exactly-once as the reader sees it, not as the log store holds it.

The ledger is the table `telemetry_sources`, one row per `(tenant_id, source_id, participant_id)`, holding the Episode, the ranges as JSON, `reported_next_seq`, `end`, `end_next_seq` and the first and last receive times. Rows are keyed by participant, so a batch signed for one participant never makes the server skip another participant's records as duplicates. A source spans participants when its User or Agent rejoins, so the watermark of a source is the union of its rows, and the binding decides which participants may add a row to that union.

The table `telemetry_source_bindings` holds one row per `(tenant_id, source_id)`: the participant of the first batch that touched the source, as its own source or as a predecessor a drop record names, that participant's User or Agent (`participants.identity_id` in the tenant, null for a guest or for a participant whose row is gone) and when it was bound. A participant may write a source when it is the bound one or a successor: another participant with the same non-null identity, which is what a User or Agent becomes when it rejoins, because a rejoin mints a new participant id. A guest has no identity, so it has no successor. The rule applies to each source a batch touches:

- When the batch's own source is bound to a participant this one may not write, the batch is refused whole with 400 and the reason `source_bound`, before the sink is written and with no row or binding changed. The client drops it as `refused` the same way it drops `ledger_full`.
- When a drop record names a predecessor that is bound to a participant this one may not write, the predecessor is barred and the rest of the batch still lands. The drop record isn't applied to the predecessor, whose rows, gaps and binding stay as they were, so its gap stays open and diagnose reads the seat it covers as unchecked, never healthy. The drop record is settled in the batch's own source as rejected with the reason `source_bound`: it gets an `sdk.telemetry.rejected` row with its type and seq, so an operator can see it, and its seq is acked and listed in `rejections`, so the client stops sending it.
- A predecessor with no binding yet is bound to the batch's participant, the same as the batch's own source.

So a participant of the tenant that learns another client's `source_id` can't add stored, dropped or closed claims to that source's watermark, or records under its seqs, and can't hide its gaps. The bindings are inserted with `on conflict do nothing` in source order inside the admission transaction, before the ledger rows are locked, and a barred predecessor gets no ledger row and no lock. An insert that meets another transaction's uncommitted binding of the same source waits for it and then reads it, so two first batches of one source from different participants leave exactly one binding: the one that commits first. A binding never changes once written. The rule lives in `telemetrydelivery.Authorize` and `telemetrydelivery.Admit`, and the in-memory and Postgres ledgers both call them.

A row holds at most 1024 ranges across its stored, rejected and dropped sets, so it stays bounded whatever a client sends, and so does the work of rewriting it on every batch. A batch that would grow a row past the cap is refused whole with 400 and the reason `ledger_full`, and the client drops it as `refused`. The budget charges 4 KiB for each predecessor source a batch names on top of its bytes, so the only row a batch creates for its bytes alone is its own source's, and rows grow no faster than batches. Neither table has foreign keys, so a late batch is never refused because an Episode or participant row is gone, and a tenant purge removes their rows by `tenant_id`. The lock is `SELECT ... FOR UPDATE` in source order inside the same transaction as the sink callback, so two batches of one source queue behind each other and the second finds the first's commit.

## Watermarks and gaps

`telemetrydelivery.Gaps` turns a source's rows into `EvidenceGap`s, and C2+C4 read them by these names:

```text
SourceWatermark { source_id, tenant_id, participants, episodes, next_seq, end, end_next_seq,
                  stored, rejected, dropped, first_received_at, last_received_at }
EvidenceGap     { source_id, from_seq, to_seq | null, cause, drop_reason?, status }
```

- The high-water mark is `end_next_seq` when the source is closed, and otherwise the larger of the reported `next_seq` and `end_next_seq`.
- Below it, every seq that is neither stored, rejected nor dropped is a `missing` gap with exact bounds.
- Dropped seqs are `dropped` gaps with their `drop_reason`.
- Past the high-water mark, a source that did not close has a `tail_unknown` gap with `to_seq: null`. No exact count exists, and none is invented.
- `status` is `open` while the source has no end (records may still arrive) and `final` once it has one. A late delivery can still shrink a final gap; nothing grows one.

A source the server never heard of has no row, so its gaps are not visible here at all. The attempt populations in C2 cover that case.

## The telemetry token

Telemetry has its own credential, so a loss no longer follows the 5-minute media credential. Every access grant response carries `telemetry: { token, expires_at }`, an EdDSA JWT with audience `chalk-telemetry`, the same subject (tenant, Space, Episode, participant) and a 24-hour lifetime. The route accepts it, and still accepts the media credential from older SDKs. It authorizes only the telemetry route, so the 24 hours buy delivery after a reload or a long background, not access: it has its own audience and its own lifetime cap, so it never verifies as a media credential and a media credential never verifies as it. The route asks the telemetry verifier first and falls back to the media verifier, and no other route accepts the telemetry token. The byte budget per participant still bounds it. The field is required in the grant contract. A refresh replay sealed before the token existed is renewed rather than replayed, so it carries one too, and a client that finds the field missing or malformed keeps using the media credential.

## Known gaps

- **The OTLP exporter buffers in memory.** The sink write is an slog row, and the OpenTelemetry batch processor holds it in memory before it reaches Axiom. A crash there loses rows the ledger counts as stored. The readback canary measures this; the model doesn't cover it.
- **Ad blockers.** The path ends in `/telemetry`, which common filter lists match. A neutral alias such as `/v1/tenants/{tenant_id}/client-events` is the proposed fix, but routing stays as it is until a browser test in slice 1 shows real blocking.
- **React Native has no journal**, so every app kill leaves an unknown tail.
- **The back-forward cache.** A page restored after `pagehide` clears its closing mark on its next record; the model doesn't cover the restore.
- **Version 1 SDKs** get no ledger, so their loss shows only as `seq` holes in the rows.
- **Liveness across realms.** The outbox knows which sources are alive only within its own JavaScript realm. A duplicated tab copies `sessionStorage`, and a same-origin iframe or a second SDK bundle shares it without sharing the realm, so either can take over a live source as if it were dead. Nothing is lost, because the server dedupes by `(source_id, seq)`, but the source is reported `abandoned` until its own `closed` end replaces that. A Web Lock held per live source would close this.
- **Guests that rejoin.** A guest has no successor. The outbox keeps one source for the life of its SDK client, so when the same client rejoins as a new guest participant, that participant's batches on the old source are refused with `source_bound`: its later records are lost and its seat reads as unchecked, never healthy. A guest reload is a new client with a new source, so its live records land. Its drop records for the old source travel in the live batches under the new participant's credential, so the server rejects them with `source_bound` and the records they name stay an open gap on the old source instead of a named drop. Starting a new source for each participant that isn't a successor, and sending a predecessor's drop records under the predecessor's credential, would close this.

## The model

`tools/formal/telemetry-delivery/run.sh` checks [TelemetryDelivery.tla](../tools/formal/telemetry-delivery/TelemetryDelivery.tla). It models the client (record, evict, drop records, journal, crash, `pagehide`, reload, dispose), the network (loss and duplicates) and the API (sink write, ledger commit, answers, partial answers, crashes), and checks:

- `AckSafe`: an acknowledged seq is stored.
- `TruthfulLedger`: the ledger names only what the sink holds.
- `OneRecordPerKey`: no two different records share `(source_id, seq)`.
- `DurableAccounted`: every durably enqueued record is with the client, stored, or named by a stored drop record.
- `Conservation`: every record the outbox accepted is one of those or inside a gap.
- `GapsHonest` and `CloseHonest`: a missing range only names seqs that were assigned, and a closed source names its last seq exactly.
- `P0Reserved`: routine records never push out a P0 record.
- `DurableDelivered` and `EndsReported`, under the fairness assumptions stated in the model: the client keeps sending what it holds and times out lost requests, the API handles what reaches it, faults are bounded, and the last session does not vanish.

The model assumes every boot's participant may write every source it names, as one User or Agent can. It doesn't model the bindings, so it doesn't cover a guest reload, where the old source's drop record is rejected and `DurableAccounted` doesn't hold for that source: its gap stays open instead.

Broken variants (answer before store, ledger before sink, dedupe on seq alone, keeping the source across a reload, evicting without a drop record, a drop list in memory only, acknowledging the whole batch, eviction without the P0 reserve, reporting an abandoned source as closed, and never loading a predecessor's journal on reload) must each produce a counterexample.

An outbox integration test records a trace of what the real code did, and `run.sh --trace` checks that trace against the model. A trace the model rejects proves the code and the model disagree. Traces that pass do not prove the code refines the model: they cover only the runs the tests made.
