# Telemetry delivery model

A TLA+ model of how a client telemetry record reaches the API exactly once: the SDK outbox with its queue, P0 reserve, drop list and journal across a reload, the network that loses and duplicates, and the ingest route that writes the sink, commits the source ledger and answers with the seqs it settled. TLC checks that an answer never names a seq the ledger has not stored, that the ledger claims only what the sink holds, that every durably enqueued record is with the client, stored or named by a stored drop record, that a gap never invents an exact range, and that routine records never push out a P0 record. Under the fairness assumptions in the model, every durable record ends up stored or named by a drop record, and every predecessor source has its end on the server. The contract it checks is [docs/telemetry-delivery.md](../../../docs/telemetry-delivery.md).

Run `./run.sh` (about a minute, Java 11 or later). It checks the code anchors, the real model for safety (`TelemetryDelivery.cfg`) and for liveness (`TelemetryDeliveryLive.cfg`), and every broken variant in `breaks`. The bounds are small on purpose: two client sessions, one record each besides drop records, a queue of one and one fault of any kind. Two records per session reach tens of millions of states and are a by-hand run.

Trace validation replays what the real outbox did. Run the delivery tests with a trace directory, then replay it:

```sh
TELEMETRY_TRACE_DIR=/tmp/telemetry-traces pnpm --dir sdks/typescript/client exec vitest run src/telemetry/outbox.delivery.test.ts
tools/formal/telemetry-delivery/run.sh --trace /tmp/telemetry-traces
```

`trace.mjs` turns each NDJSON trace into `TraceData.tla`, and `TelemetryDeliveryTrace.tla` asks TLC whether some run of the model takes every line. When none does, `run.sh` names the first line the model can't take. A trace the model rejects proves the code and the model disagree; traces that pass don't prove the code refines the model, because they cover only the runs the tests made.

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break.
