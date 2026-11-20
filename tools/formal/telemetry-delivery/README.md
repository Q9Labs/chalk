# Telemetry delivery model

A TLA+ model of client telemetry delivery: the SDK journal and queue, a lossy network, the source-owner fence, and the server's durable outbox. The API commits accepted payloads with the ranges and can ACK before export. A server crash clears the in-flight request, not the committed payload. Export moves pending rows to the sink independently.

TLC checks that ACKs name only settled seqs, stored seqs have a durable payload, and sink rows were committed. It also checks source ownership, close boundaries, honest gaps, drop accounting and P0 priority. Liveness assumes the API and relay eventually make progress, including capacity for retried intake after backpressure. The sink gives a full receipt on success and retains rows for the read horizon. Stable record keys let the reader collapse repeated exports. The model collapses a successful export and deletion into one step; a failed export or lost receipt may leave the same payload pending. The database and HTTP regression tests exercise that retry. Sync's enqueue and the reader's server coverage are outside this model. See [the delivery contract](../../../docs/telemetry-delivery.md).

Run `./run.sh` (Java 11 or later). It checks the code anchors, the real model for safety and for liveness, each without and with a join as another Participant, and every broken variant in `breaks` under the bounds its row names. The bounds are small on purpose: `TelemetryDelivery.cfg` has two client sessions, one record each besides drop records, a queue of one and one fault of any kind; `TelemetryDeliveryJoin.cfg` adds one join and drops the fault, and is most of the run time at about 33 million states; `TelemetryDeliveryLive.cfg` and `TelemetryDeliveryLiveJoin.cfg` are the liveness runs. A join together with a fault across a reload passed 25 million distinct states in three minutes with its queue still growing, so it and two records per join are by-hand runs.

Trace validation replays what the real outbox did. Run the delivery tests (`sdks/typescript/client/src/telemetry/outbox.delivery.test.ts` and `sdks/typescript/client/src/telemetry/outbox.delivery.rejoin.test.ts`) with a trace directory, then replay it:

```sh
TELEMETRY_TRACE_DIR=/tmp/telemetry-traces pnpm --dir sdks/typescript/client exec vitest run src/telemetry/outbox.delivery
tools/formal/telemetry-delivery/run.sh --trace /tmp/telemetry-traces
```

`trace.mjs` turns each NDJSON trace into `TraceData.tla`, and `TelemetryDeliveryTrace.tla` asks TLC whether some run of the model takes every line. When none does, `run.sh` names the first line the model can't take. A trace the model rejects proves the code and the model disagree; traces that pass don't prove the code refines the model, because they cover only the runs the tests made.

`anchors` lists the code fragments each action mirrors; `run.sh` fails when one is gone. `breaks` lists the broken variants and the rule each must break.
