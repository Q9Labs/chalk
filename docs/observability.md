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

### Capture Entrance preparations

`recording.entrance.prewarmed` is emitted after an Automatic Space's Entrance
preparation commits. Repeated opens within its five-minute lifetime do not emit
another creation or extend the deadline. `recording.preparation.consumed` carries
`consumed=true` when Recording admission replaces preparation demand, and
`consumed=false` for a cold admission. These structured logs use request context
for correlation and never contain invite tokens or participant details.
`recording.entrance.failed` reports preparation failures; public requests also
use the standard `public_invite.request` log/span with success, rejection, and
failure outcomes. The HTTP proof checks successful and rejected Entrance
requests through this middleware, including invite-token exclusion from logs.

Public Entrance requests require a verified, enabled, current-generation invite;
a Space slug is not sufficient. Dashboard requests require Tenant Space-read
access. Manual, Disabled, archived, and already-recording Spaces do not pre-warm.
Opening an Entrance advances a future preparation to now using its current
revision. No schema migration or new fleet provisioning path is required.

Demand expires exactly five minutes after preparation. With the default healthy
five-second reconciliation cadence, an isolated idle node closes admission,
revokes identity, and is deleted within three more reconciliations: at most
5m15s, approximately $0.0007814 at $0.00893/hour. Missing observations can use the
existing five-minute drain timeout: conservatively 10m15s, approximately
$0.0015256. These are controller-time bounds for an isolated node, not a provider
billing guarantee: other fleet transitions, controller outages, or failed
provider deletion can delay cleanup. Preparations are unique per Tenant/Space,
and total preparation demand is capped at ten minus active base demand.

Provider analytics/logs/webhooks require deployment-specific account connectors. Local checks cover Chalk adapters and endpoint observations, not Cloudflare's internal SFU behavior.

Pre-runtime events, hard crashes before export, unregistered native peer connections, device/carrier internals, and provider actions with no visible output can remain unobserved. Leave unattributable connections unassigned. Use journey sequence and receive time without claiming perfect clock ordering. Expose exporter drops/failures and pipeline-canary alerts instead of implying complete coverage.

## Local checks

Production user-facing alerts use [native Axiom monitors and Discord](../infrastructure/observability/production-alerts/README.md),
with read-only Postgres snapshots for durable job state. Local Grafana provisioning
is not a production route. A created monitor or a direct Discord webhook test does
not establish end-to-end production alert delivery.

```sh
pnpm run observability:start
pnpm run observability:smoke
pnpm run observability:stop
```

The stack includes a minute-by-minute trace/metric/log canary. Smoke checks send and query correlated signals and check the dashboard/critical alerts. API and Sync gates cover durable intake, idempotency, propagation, and service health. Live provider connectors and alert delivery need their own checks.

## Recording Export video degradation

Render holds each source's last decodable frame over video damage, including a
loss at the end of the source. A source with no decodable frame uses its normal
placeholder tile. Audio remains on the recording-relative clock. An Export
with neither decodable video nor audio fails with `recording has no decodable
video or audio`; video damage alone does not reject an Export.

Render job `result_metadata.video_degradation` stores per-source frozen
milliseconds, dropped frames, recoveries and whole-source placeholder time.
These are internal job facts, not additions to the public Export API.

A successfully committed degraded Export emits one `recording.export.degraded`
structured event with its job ID, total frozen milliseconds, degraded source
count, and counters for at most 16 sources (plus an omitted count). Logged
sources use list positions and media kinds, never source, participant, Recording
or Episode identifiers. No media payloads are logged. Production alerting can
count this event independently of failed Exports.

Resolution switches restart decoding at complete keyframes and normalize each
segment to the first segment's dimensions, preserving aspect ratio and RTP
spacing. Known replays are redundant copies, not additional lost frames. Codec
validation discards undecodable pictures and waits for a usable keyframe before
resuming; source preparation fills frozen spans before compositor input seeks.
