# Telemetry delivery

This is contract C3 of the observability foundation. It says how a client record gets from the SDK to the server exactly once, how the server acknowledges it, and what the server can claim when a record never arrives. The rule it guards is **delivery conservation**: every durably enqueued record is stored once or named by a stored drop record, and a record that is neither is inside a gap the server can name. A source that vanishes without a persisted high-water mark leaves an `evidence_gap` with an unknown tail, never an invented exact range.

The model that checks the rule is [TelemetryDelivery.tla](../tools/formal/telemetry-delivery/TelemetryDelivery.tla). The reference code is the SDK outbox (`sdks/typescript/client/src/telemetry/`), the ingest route (`apps/api/internal/httpapi/telemetry.go`) and the source ledger (`apps/api/internal/telemetrydelivery` and its Postgres adapter). [Observability](observability.md#client-telemetry) covers what the rows mean.

## Names

These names are shared with C1 (IDs and envelope) and C2+C4 (witnesses and output). Use them exactly.

| Name              | What it is                                                                                                                                                                                                                                                                                             | Minted by                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `source_id`       | The stream a record belongs to. For the SDK it is one join of one SDK client (`cs_` in display): one page or app run as one Participant. A reload is a new source, and so is a join as another Participant inside the same run. Each source has exactly one owner, the Participant of its first batch. | client, a UUID per join          |
| `seq`             | The record's position in its source: 0, 1, 2 and so on with no reuse. `(source_id, seq)` is the record's identity and the dedupe key.                                                                                                                                                                  | client, at record time           |
| `event_id`        | A UUID per record, minted with its `seq`. It is the evidence handle (`ev_` in display), and a reader that sees two `event_id`s for one `(source_id, seq)` has found a bug.                                                                                                                             | client, at record time           |
| `batch_id`        | A UUID per batch. A batch never changes while it is in flight, and a retry resends it with the same `batch_id`.                                                                                                                                                                                        | client, when it forms the batch  |
| `next_seq`        | The source's high-water mark: every seq below it has been assigned.                                                                                                                                                                                                                                    | client, on every batch           |
| `end`             | How a source ended: `closed` (the client said its last `next_seq` exactly) or `abandoned` (a successor found it dead and reports the last high-water mark it persisted).                                                                                                                               | client                           |
| `SourceWatermark` | What the server knows of a source: its high-water mark, its end and which seqs are stored, rejected or dropped.                                                                                                                                                                                        | server ledger                    |
| `EvidenceGap`     | A seq range the server cannot account for, with its cause.                                                                                                                                                                                                                                             | server, computed from the ledger |

## The wire

`POST /v1/tenants/{tenant_id}/telemetry`, body at most 64 KiB:

```json
{
  "version": 2,
  "source_id": "0b7c…",
  "batch_id": "5d1e…",
  "next_seq": 42,
  "end": "closed",
  "events": [
    { "event_id": "9a4f…", "seq": 40, "elapsed_ms": 81234, "type": "call_ended", "…": "…" },
    { "event_id": "c2d8…", "seq": 41, "elapsed_ms": 81240, "type": "telemetry_dropped", "dropped": 3, "drop_reason": "queue_full", "dropped_seqs": [{ "from": 12, "to": 15 }] }
  ]
}
```

- `events` holds 0 to 100 records. An empty batch is allowed only when it carries `end`.
- A drop record is a `telemetry_dropped` event. `dropped_seqs` lists half-open ranges `[from, to)` of its own source, at most 64, all below the drop record's own seq. `drop_reason` is `queue_full`, `credential_expired` or `refused`. The ranges name records the client gave up on; the drop record itself is P0 and never evicted.
- Version 1 bodies (`{ version: 1, client_session_id, events }`) from SDKs that predate this contract are still accepted. They are logged as before and never touch the ledger, so they get no acknowledgment and no gaps.

The answer to a version 2 batch:

```json
{ "accepted": 1, "rejected": 1, "duplicates": 0, "acks": [{ "from": 40, "to": 42 }], "rejections": [{ "seq": 41, "reason": "range" }], "end_rejection": "end_short" }
```

- `acks` names every seq of the batch that is **settled**: stored now, stored before (a duplicate), or rejected for its content. Settled is not stored. A rejected record is logged as `sdk.telemetry.rejected` with its reason, is final, and stays a `rejected` gap: sending it again changes nothing, and it never counts as coverage.
- A seq of the batch that `acks` does not name is unsettled. The client keeps it and sends it again. The server answers this way when it settles only part of a batch.
- `end_rejection` is present when the ledger did not apply the batch's `end`: `end_short` when the end lies below the committed history, and `end_conflict` when the source already closed at another `next_seq`. The rest of the batch still lands.
- Status codes settle nothing. 400 means the batch is wrong or not allowed: a bad frame (`schema`), a row past its range cap (`ledger_full`), a source another Participant owns (`source_owned`) or a new source past the Participant's budget (`source_budget`). 403 with `participant_gone` means the tenant or the Participant no longer exists. 413 means the body is too large. On each of these the live source drops the batch and names it with reason `refused`, and a retired source is abandoned. 401 means refresh the credential, or drop with `credential_expired` when the subject has no fresh one. 429, 5xx, a timeout and a network error mean send the same batch again after backoff. When the ledger is down the API answers 503 with `Retry-After` and writes nothing.

## The client

1. **Stamping.** `record()` gives the record the live source's `source_id`, the next `seq` and a new `event_id`, and queues it.
2. **Priority.** Each event type has a class in one exhaustive table: `p0` for the records that explain why a call failed or ended (`call_ended`, `connection_failed`, `render_crashed`, `problem_reported`, `telemetry_dropped`, the space join span, recovery exhaustion, access refresh failure, device failure and unconfirmed cleanup), `stats` for `call_stats`, and `routine` for the rest.
3. **Reservation.** Each source has its own queue. Routine and stats records may fill at most half of its byte budget, and they never push out a P0 record. When the queue is full it gives up stats first (folding two windows into one keeps the newer and drops the older), then routine records, oldest first, and a P0 record only when nothing else is left. Every record it gives up joins the source's **drop list**.
4. **Drop records.** The next drain turns a source's drop list into one `telemetry_dropped` record of that same source, sent like any P0 record. A drop record is never evicted. While an earlier drop record is unsettled the list waits, so a long outage grows the list rather than the queue.
5. **Batches.** A batch takes up to 100 records of one source, at most 48 KiB, and gets a `batch_id`. The journal saves the source's high-water mark before the batch leaves, so no `next_seq` the server has seen is above what a successor would report. A batch is immutable until its answer arrives, and one batch per source is in flight at a time.
6. **Settling.** The client removes exactly the seqs `acks` names and keeps the rest.
7. **Joins.** When the credential starts speaking for another Participant, the live source retires and a new source starts at seq 0. The retired source keeps its own credential, names its own drop list in a drop record of its own, and then sends `end: "closed"` with its exact `next_seq`. Its batches go only under that credential, so a source never carries records of two Participants.
8. **The journal.** On the web the outbox keeps one journal entry per source in `sessionStorage` (`TelemetryJournal` in the platform), which a reload of the same tab can read and other tabs cannot. It holds the source's Participant subject and credential, its P0 records not yet settled, its drop list, its high-water mark and the end it still owes. A P0 record is written to the journal before `record()` returns, so P0 means **durably enqueued**. The high-water mark is saved before every batch, at most every 5 seconds otherwise, and exactly on `pagehide`, with a closing mark.
9. **Reload.** A new boot is a new source. It reads its predecessors' journals and sends each one's records and end under that predecessor's own `source_id` and credential: `closed` with the exact `next_seq` when the predecessor saved its closing mark, otherwise `abandoned` with the last `next_seq` it persisted. A closing predecessor's drop list is named in a drop record of that source at its exact mark. An abandoned predecessor's drop list is not sent, because its saved mark is only a lower bound and a drop record minted there could take the seq of a record the dead page made and lost; those seqs stay a gap. When a predecessor's credential has expired nothing more of it can be sent, so it is abandoned in the client and its gap stays open on the server.
10. **Disposal.** `dispose()` turns the whole drop list into drop records, even past an unsettled one, because no later drain will. It sends what it holds, then sends `end: "closed"` with the exact `next_seq`. What stays unsettled stays in the journal, and the next client in the tab sends it.

React Native has no journal yet, so an app kill leaves an unknown tail there. A slice adds one through the same `TelemetryJournal` port.

## The server

The handler does this for one batch, in one ledger transaction:

1. Decode the frame and mark each record accepted or rejected for its content.
2. Check that the tenant and the Participant are live, under a lock that holds them until the commit, and lock the source's row (`SELECT … FOR UPDATE`).
3. Refuse the batch when the source belongs to another Participant (`source_owned`), or when it is new and the Participant already owns 64 sources (`source_budget`).
4. Find the new seqs: those not already stored or rejected for the source. A new valid record is stored, a new invalid one is rejected, a record at or past a closed end is rejected with `after_end`, and a stored drop record marks the seqs it names as dropped in the same source.
5. Check the end against the committed history, then raise the reported high-water mark (see below).
6. Write the new accepted payload to `telemetry_outbox` and commit it with the source row.
7. Log new rejections and answer with `acks`. The reply does not wait for Axiom.

A failed commit acknowledges nothing. A retry after commit returns the same settled seqs without recreating the payload. The API relay claims a bounded group of pending payloads and deletes it only after a full Axiom ingest receipt. A refused group retries one payload at a time. A lost reply between ingest and deletion can yield duplicate rows in Axiom; the reader deduplicates by event ID and fact. It still reports a stored seq as unread until its row is visible. Receipt time does not advance after a source closes.

The ledger is the table `telemetry_sources`, one row per `(tenant_id, source_id)`, holding its owner (the Participant and Episode of the first batch), the ranges as JSON, `reported_next_seq`, `end`, `end_next_seq` and the first and last receive times. A row is written only by its owner, so a Participant of the tenant that learns another client's `source_id` can't add stored, dropped or closed claims to that source, or records under its seqs, and can't hide its gaps. An empty batch that only closes a new source creates one row.

**Ends.** A closed end is final: the same close again changes nothing, and any other `next_seq` gets `end_conflict`. Otherwise the floor is one past the highest seq the row stores or rejects, and at least the largest `next_seq` an earlier batch reported. An end below the floor would hide the seqs between it and the floor, so it gets `end_short` and is not applied, and those seqs stay a gap. An end at or above the floor replaces an abandoned end, so a close settles what a later load found dead.

**Bounds.** A row holds at most 1024 ranges across its stored, rejected and dropped sets, so it stays bounded whatever a client sends, and so does the work of rewriting it on every batch. A batch that would grow a row past the cap is refused whole with `ledger_full`. A Participant owns at most 64 sources, so a still-valid credential can't allocate rows without end. A User keeps one Participant per Episode and every page load or join starts a new source, so the cap sits well above a long call with many reloads. A source refused at the cap, or a page that dies before its first batch, never reaches the ledger, and nothing names it. The reader therefore never lets a closed source stand for its seat after its close: time in the seat's window that no source covers is a gap (see [diagnose](diagnose.md)). The byte budget per Participant charges each request its bytes.

**Purge.** Tenant purge deletes the pending payloads and source rows by `tenant_id`. Admission locks the outbox before the source table, in the same order as purge, then checks the Participant row under a key share lock (no key update for a new source, which also serializes one Participant's source creations against the budget). The relay takes the outbox write lock before claiming rows. A version 1 batch has no ledger row, but it passes the same Participant check before anything is logged, so a still-valid credential of a purged Tenant or a removed Participant gets `participant_gone`.

## Watermarks and gaps

`telemetrydelivery.Gaps` turns a source's row into `EvidenceGap`s, and C2+C4 read them by these names:

```text
SourceWatermark { source_id, tenant_id, participants, episodes, next_seq, end, end_next_seq,
                  stored, rejected, dropped, first_received_at, last_received_at }
EvidenceGap     { source_id, from_seq, to_seq | null, cause, drop_reason?, status }
```

- The high-water mark is `end_next_seq` when the source is closed, and otherwise the larger of the reported `next_seq` and `end_next_seq`.
- Below it, every seq that is neither stored, rejected nor dropped is a `missing` gap with exact bounds.
- Rejected seqs are `rejected` gaps: the records reached the server but were not stored.
- Dropped seqs are `dropped` gaps with their `drop_reason`.
- Past the high-water mark, a source that did not close has a `tail_unknown` gap with `to_seq: null`. No exact count exists, and none is invented.
- `status` is `open` while the source has no end (records may still arrive) and `final` once it has one. A late delivery can still shrink a final gap; nothing grows one.

A stored seq whose row the reader can't find is a gap too, found by the reader's row check rather than by the ledger. A source the server never heard of has no row, so its gaps are not visible here at all. The attempt populations in C2 cover that case.

## The telemetry token

Telemetry has its own credential, so a loss no longer follows the 5-minute media credential. Every access grant response carries `telemetry: { token, expires_at }`, an EdDSA JWT with audience `chalk-telemetry`, the same subject (tenant, Space, Episode, Participant) and a 24-hour lifetime. The route accepts it, and still accepts the media credential from older SDKs. It authorizes only the telemetry route, so the 24 hours buy delivery after a reload or a long background, not access: it has its own audience and its own lifetime cap, so it never verifies as a media credential and a media credential never verifies as it. The route asks the telemetry verifier first and falls back to the media verifier, and no other route accepts the telemetry token. The byte budget per Participant still bounds it. The field is required in the grant contract. A refresh replay sealed before the token existed is renewed rather than replayed, so it carries one too, and a client that finds the field missing or malformed keeps using the media credential.

## Known gaps

- **Axiom can lag or refuse delivery.** Pending payloads stay in Postgres and the relay logs `telemetry.relay_retry`. Set up the existing Axiom log dataset and ingest grant before enabling delivery. The shared outbox holds up to 64 MiB of payload and per-row allowance. After that, new V2 payloads get a retryable response without an ACK. Acknowledged evidence does not expire from the outbox.
- **Ad blockers.** The path ends in `/telemetry`, which common filter lists match. A neutral alias such as `/v1/tenants/{tenant_id}/client-events` is the proposed fix, but routing stays as it is until a browser test in slice 1 shows real blocking.
- **React Native has no journal**, so every app kill leaves an unknown tail.
- **The back-forward cache.** A page restored after `pagehide` clears its closing mark on its next record; the model doesn't cover the restore.
- **Version 1 SDKs** get no ledger, so their loss shows only as `seq` holes in the rows.
- **Liveness across realms.** The outbox knows which sources are alive only within its own JavaScript realm. A duplicated tab copies `sessionStorage`, and a same-origin iframe or a second SDK bundle shares it without sharing the realm, so either can take over a live source as if it were dead. Nothing is lost, because the server dedupes by `(source_id, seq)`, but the source is reported `abandoned` until its own `closed` end replaces that. A Web Lock held per live source would close this.
- **Expired predecessors.** A predecessor whose credential expired before a reload could send it is abandoned in the client and sends nothing, not even its end. If the server never heard of it, it has no row and no gap; otherwise its tail stays `tail_unknown` and diagnose reads the seat as unchecked, never healthy.

## The model

`tools/formal/telemetry-delivery/run.sh` checks [TelemetryDelivery.tla](../tools/formal/telemetry-delivery/TelemetryDelivery.tla). It models the client (record, evict, drop records of each source, journal, joins as another Participant, crash, `pagehide`, reload, dispose), the network (loss and duplicates), another Participant of the tenant that sends a forged batch or end for a source it learned, and the API (owner check, atomic ledger and payload commit, an independent relay and ACK, partial answers, content rejections, stale ends below the floor, and crashes before and after the commit), and checks:

- `AckSafe`: an acknowledged seq is committed as stored or rejected.
- `SinkCommitted`: pending and exported rows both require a committed sequence.
- `TruthfulLedger`: a stored seq has its row, and a dropped seq is named by a drop record with its row, in the pending outbox or the sink.
- `OwnerWrites`: only a source's own Participant writes it. The row's owner is the Participant whose credential sends the source, every stored or rejected seq is one the client minted for it, and every pending or exported row is a record the client made.
- `OneRecordPerKey` and `SeqNeverReused`: no two different records share `(source_id, seq)`, in durable evidence or anywhere the client minted them.
- `DurableAccounted`: every durably enqueued record is with the client, pending export, stored, or named by a durable drop record. The only exceptions are losses the server names: a rejected record or the unsent drop list of an abandoned source, and each of those is inside a gap.
- `Conservation`: every record the outbox accepted is one of those or inside a gap.
- `GapsHonest` and `CloseHonest`: a missing range only names seqs that were assigned, and a closed source names its last seq exactly.
- `SuffixKept`: a close never lies below a stored or rejected seq.
- `P0Reserved`: routine records never push out a P0 record.
- `DurableDelivered` and `EndsReported`, under the fairness assumptions stated in the model: the client keeps sending what it holds and times out lost requests, the API handles what reaches it, the relay can eventually export, faults are bounded, and the last session does not vanish.

The model assumes a full sink receipt and retention through the read horizon, a valid credential for every source while the client sends for it, a journal that survives a reload, and a live tenant and Participant. The purge fence and the source budget are checked by the ledger tests instead. `TelemetryDelivery.cfg` checks two sessions with one fault, and `TelemetryDeliveryJoin.cfg` checks two sessions with one join and no fault.

Broken variants must each produce a counterexample: answering before the commit, writing the sink before the commit, omitting the payload from the commit, counting a rejected record as stored, applying an end below the floor, sending a batch before its high-water mark is saved, keeping one source across joins, naming an abandoned predecessor's drop list at its saved mark, dedupe on seq alone, keeping the source across a reload, evicting without a drop record, a drop list in memory only, acknowledging the whole batch, eviction without the P0 reserve, reporting an abandoned source as closed, never loading a predecessor's journal on reload, and skipping the owner check, which lets a forged batch or end into the source.

An outbox integration test records a trace of what the real code did, and `run.sh --trace` checks that trace against the model. A trace the model rejects proves the code and the model disagree. Traces that pass do not prove the code refines the model: they cover only the runs the tests made.
