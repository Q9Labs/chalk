# Observability

Chalk sends traces, metrics, and logs through OpenTelemetry to Tempo, Prometheus, and Loki, viewed in Grafana alongside the Postgres journey ledger.

## Correlation

| Surface   | Journey field        |
| --------- | -------------------- |
| HTTP      | `x-chalk-journey-id` |
| WebSocket | `journey_id`         |
| Telemetry | `chalk.journey.id`   |

The first observer creates the journey and W3C context only when none exists. Propagate `traceparent` and `tracestate` through downstream work. Use parent/child spans for synchronous or propagated OTP work, and span links for independent fan-out and late callbacks.

The append-only Postgres ledger uses idempotent event IDs and ordering. The highest ordered terminal event determines the result; late retries cannot overwrite it. Preserve lifecycle events across reconnects and split traces.

Webhook Events retain the producer's journey/trace reference and a queued branch per Delivery. Each Attempt starts a producer-linked trace and ends as succeeded, exhausted, canceled, or erased. Manual redelivery and `endpoint.test` start their own linked roots. Customer bodies and Standard Webhooks headers never expose internal journey/trace IDs.

## Client intake

Telemetry is opt-in. Mobile enables it with an intake-capable token provider. Web needs `VITE_CHALK_TELEMETRY_ENABLED=true` and an authenticated `VITE_CHALK_API_URL`; marketing without credentials stays inert.

Client batches are bounded to 100 events per request; explicit and unload/keepalive flushes don't wait for the normal batch window.

Intake rejects tenant API keys. It accepts verified provider/RealtimeKit participant bearers or authenticated User bearer/cookie credentials, with expiry/revocation checks and rate limits. Chalk media grants and `AccessGrant` envelopes are not intake credentials. Tenant attribution/governance beyond this remains deferred.

## Instrument and verify

- Cover meaningful success, rejection, retry, timeout, and terminal failures across SDK, API, Sync, provider adapters, stores, and webhook delivery. Use bounded attributes; never include credentials, secrets, sensitive payloads, media content, or whiteboard content.
- Keep a journey's errors, terminal events, and pipeline-health signals complete when sampling routine detail. Summarize RTC data; retention and budgets are deployment settings.
- Test a successful journey and a distinct failure, then query the relevant trace, metrics, logs, and ledger events. The execution trace harness is an explainer, not operational proof.
- Add actionable alerts and test their signal source. Test notification delivery separately; a Grafana alert doesn't establish that someone received it.
- Register new services in `infrastructure/uptime-worker/src/index.ts`, add tests and public status where appropriate, and observe the deployed check fail and recover.

## Sync diagnostics

`/diagnostics/healthz` is separate from general readiness: it returns `200` only when the exporter is configured and healthy, otherwise `503`. Diagnostic delivery failure must not stop collaboration traffic.

The response exposes bounded counters, ages, and failure classes—not URLs, identifiers, credentials, response bodies, or raw transport errors. The uptime target is `sync.diagnostics`. Successful append clears degradation; cumulative failures/dropped batches remain in `/metrics`.

Verify a rejected append → monitor failure → restored intake → successful append/recovery and durable cursor. Whiteboard sockets record scoped `whiteboard.connect`, `whiteboard.recover`, and `whiteboard.disconnect` events; terminal events include bounded close details and trace correlation, not protocol frames.

## Limits

Provider analytics/logs/webhooks require deployment-specific account connectors. Local checks cover Chalk adapters and endpoint observations, not Cloudflare's internal SFU behavior.

Pre-runtime events, hard crashes before export, unregistered native peer connections, device/carrier internals, and provider actions with no visible output can remain unobserved. Leave unattributable connections unassigned. Use journey sequence and receive time without claiming perfect clock ordering. Expose exporter drops/failures and pipeline-canary alerts instead of implying complete coverage.

## Local checks

```sh
pnpm run observability:start
pnpm run observability:smoke
pnpm run observability:stop
```

The stack includes a minute-by-minute trace/metric/log canary. Smoke checks send and query correlated signals and check the dashboard/critical alerts. API and Sync gates cover durable intake, idempotency, propagation, and service health. Live provider connectors and alert delivery need their own checks.
