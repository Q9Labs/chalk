# Observability

API request logs, API metrics and Sync event spans export to Axiom. The private table `observability_journey_events` is the durable correlation record for webhook and recording lifecycles. Code defines the event names, fields and metrics; search it (`apps/api/internal/observability`, `apps/sync`) instead of trusting a list here. This page keeps the rules and the reading judgment.

## Correlation

- Every operation is a trace and the request ID is the trace ID. Carry `traceparent` across every hop, including workers, the recorder and the dispatcher.
- A session is one run of a Chalk app on one device. The SDK sends it as W3C `baggage: session.id=<uuid>` on every API request and in the Sync `hello` frame. The API and Sync copy a valid lowercase UUID onto spans and logs and ignore anything else. It is never an Episode, a Cloudflare session or a dashboard `sessionId`. It is not written to the ledger, to Sync frames sent back, or to durable rows.
- Deploy the API and Sync before the SDK, and keep `Baggage` in the API's CORS allow list. An older Sync rejects a `hello` that carries baggage, and the SDK then retries once without it.
- Dataset names, tokens and monitor IDs are private deployment inputs. This repo is public, so keep them out.

## Follow an incident

Start with the Episode ID, plus the participant ID, the server error code and the trace or request ID from a failed join. In the API log or Sync trace dataset, run `| search "<episode-id>"` and then narrow by Tenant, Space, participant or trace ID. To see everything one device did, including requests before the join and across several joins, filter `['session.id'] == "<session-id>"` in both datasets. A user can quote the session ID from Call details or a problem report.

A missing failure report does not prove success. A worker can lose its lease or its API connection before it reports. Join recording events by operational job and worker attempt, not by Tenant or Episode.

## Rules for new telemetry

A terminal failure, rejection or timeout must say why, in a bounded and redacted form ([coding standards](../CODING_STANDARDS.md)).

- Tags and metric attributes use a fixed, small set of values. A metric never carries an Episode, Tenant or Participant ID. Put the ID in a log line and search the log.
- Allowlist error text. Provider descriptions, raw transport errors, SDP, URLs, paths and anything media-derived can echo hosts, addresses or content. Export a code class, a fixed phrase or a hash (`provider_message_fingerprint`, `participant_id_hash`) instead.
- Tokens, grants, authorization headers, tool arguments, transcript text and audio never enter a log, span or metric.
- Bound state kept for diagnostics (entries, bytes, age), and make a full or failed diagnostic degrade to silence. Diagnostics must never fail the user's operation.
- Count a decision once and name the outcome (`moved`, `refused_no_room`), so a rate shows what is wrong.
- Sample success, keep failures.

## Journey ledger and proof

Add a ledger event when a durable lifecycle boundary changes: the Episode, a participant, a publication, a recording, a webhook delivery. Do it in the same transaction as the change, link it to the parent event, and carry trace and span IDs. The webhook events are listed in `contract/webhooks/v1/journey-events.json`. MCP adds no parallel ledger.

Do not add a ledger event for transient delivery that the client observes, such as a congestion pause, a retry, an ICE detail or a diagnostic sample. Their evidence is logs, metrics and call stats. Telemetry from the SFU cannot replace durable Postgres lifecycle evidence.

When a lifecycle boundary changes, update the ledger and the executable proof in the same change. The proof is a test that drives the real journey and checks the ledger rows, the trace correlation and the redaction. A success path alone is not enough: check that a rejected or failed report emits no success evidence.

## Reading call quality

The SDK uploads a WebRTC summary about every minute while a call is open, and the API logs each one as `sdk.call_stats` with the session ID, a hashed participant ID, the connection type (`udp`, `tcp`, `turn`), loss, jitter, RTT, freezes and the provider. `provider_session_id` is the connection ID the own SFU logs and returns from `/inspect`, so a device joins to the SFU's view of the same connection.

To compare providers after a cutover step, or when a connection report points at one provider:

```apl
['<api-log-dataset>']
| where ['attributes.event'] == "sdk.call_stats"
| extend provider = iff(tostring(['attributes.provider']) in ("cloudflare_sfu", "chalk_sfu"), tostring(['attributes.provider']), "unknown")
| summarize
    samples = count(),
    rtt_p50 = percentile(todouble(['attributes.rtt_ms']), 50),
    rtt_p95 = percentile(todouble(['attributes.rtt_ms']), 95),
    recv_loss_p95 = percentile(todouble(['attributes.recv_loss_pct']), 95),
    freeze_rate = sumif(todouble(['attributes.freeze_count']), isnotnull(['attributes.freeze_count'])) / count()
  by provider
```

Check `samples` before you trust a percentile, because each sample covers about ten seconds. Add `['attributes.connection_type']` to separate relayed calls from direct ones, or `bin(_time, 1h)` for a trend. Check field paths against how the dataset maps `sdk.connection_report`. Nothing pages on this query.

A rising `recv_paused_videos` with low receive bitrate means the own SFU is protecting audio on a slow link. It is not a receive stall.

## What an alert means

The rules, thresholds and delivery setup are in [production alerts](../infrastructure/observability/production-alerts/README.md). The own-SFU on-call steps are in its [runbook](../infrastructure/observability/production-alerts/sfu-runbook.md). The listener audio check is in [its README](../infrastructure/listener-audio-alert/README.md). The judgment behind them:

- **TURN credentials fail.** The join continues on STUN only, so clients on UDP-blocked networks cannot connect media. One failed mint is a blip, so the monitor pages on three in five minutes. Find the affected class by searching the log for the Episode ID.
- **Own SFU recovery refused.** A live Episode on a silent or restarted node moves through one generation-fenced binding change. A sustained `refused_*` outcome means live calls cannot leave a lost node, so check pool capacity first. A single `moved` is still worth a look at the lost node.
- **Retirement debt stuck.** A moved or ended Episode owes a retire to each node it left. The Episode end counts as confirmed once the debt row is durable, not when the node acknowledges. A healthy fleet pays a debt within seconds, so a debt older than 15 minutes means a node has stayed silent through many backoff cycles. Check that node, and restart it if it is up but not answering control calls. A silent node keeps its sessions until it restarts, but media stops within the source lease TTL because the API stops renewing the lease.
- **Sync stays unready.** Sync's own probes already apply hysteresis, so paging on each probe would be noise. The rule needs four unready minute samples in five. It ignores a short blip and catches a sustained outage. Missing samples do not prove continued unreadiness. The freshness monitor catches a stopped collector.
- **Listener audio.** An unpulled publication (Cloudflare SFU only) or `audio_receive_stuck` client reports from at least two distinct participants on one Episode page Oncall. The client report is the provider-neutral signal. Point `CHALK_AXIOM_LOG_DATASET` at the production API log dataset only: the query does not filter by environment, so a dataset that also holds nightly logs would page for nightly.
- **Connection-report rules.** They alert on one affected participant per Tenant, Episode and failure. A cleared threshold does not prove the person rejoined or recovered.

Process-local diagnostics, such as the listener publication sampler, reset on an API restart. A pull-acceptance signal proves the provider accepted the pull, not that packets arrived or renegotiation finished.

## Hosted MCP

`/mcp` uses the API's HTTP trace context, and each application call adds a child span named `mcp.<operationID>`. Look for `mcp.protocol.rejected` (schema or protocol failure) and `mcp.origin.rejected` (Origin denial). `mcp.oauth.*` events carry grant, tenant and client IDs only. A rise in `reuse_detected` means a client is racing refreshes or a token leaked.

## Transcription

Transcript requests keep the dispatcher and API transcript lifecycle and its journey carrier. Failures keep bounded `provider_*` retry reasons and never carry transcript text, provider bodies or audio. A silent chunk completes with zero cues and zero cost, not as a provider failure.
