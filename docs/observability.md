# Observability

API request logs, API metrics and Sync event spans export to Axiom. The private table `observability_journey_events` is the durable correlation record for webhook and recording lifecycles. Code defines the event names, fields and metrics; search it (`apps/api/internal/observability`, `apps/sync`) instead of trusting a list here. This page keeps the rules and the reading judgment.

## Correlation

- Every operation is a trace and the request ID is the trace ID. Carry `traceparent` across every hop, including workers, the recorder and the dispatcher.
- A session is one run of a Chalk app on one device. The SDK sends it as W3C `baggage: session.id=<uuid>` on every API request and in the Sync `hello` frame. The API and Sync copy a valid lowercase UUID onto spans and logs and ignore anything else. It is never an Episode, a Cloudflare session or a dashboard `sessionId`. It is not written to the ledger, to Sync frames sent back, or to durable rows.
- Every API response names its request in the `x-chalk-journey-id` header, which CORS exposes. The same ID is `journey_id` on the request log line, on logs and spans started under the request, and on the ledger rows it writes. The client never sends one: the ledger keys one lifecycle by its journey ID, so an ID shared by a session would merge unrelated joins and recordings. Follow a device by `session.id` and one failure by its journey ID. The SDK keeps the latest failed response's journey ID (`lastFailedRequest`), and web problem reports print it as `Last failed request: <journey id> (HTTP <status>)`.
- The `http.request` log line carries `route` (the matched pattern, `unmatched` when none), `status`, `tenant_id` when the route has a valid `{tenant_id}`, and `error_code`, the public API code of a failed response, so a 403 or 409 names the rule that refused it. When a provider's refusal sits behind another public status, the line and the `http.failure` line add `upstream_status` and `upstream_code`; a code that is not a short lowercase token is logged as `unsafe`. The server span and the `journey.phase.http` span carry `http.route` and `tenant.id`: group latency by `http.route`, never by path.
- The API injects `traceparent`, never `baggage`, into its calls to the Chalk SFU and into webhook deliveries, so the session ID stays inside Chalk.
- Deploy the API and Sync before the SDK, and keep `Baggage` in the API's CORS allow list. An older Sync rejects a `hello` that carries baggage, and the SDK then retries once without it.
- Dataset names, tokens and monitor IDs are private deployment inputs. This repo is public, so keep them out.

## Follow an incident

Start with the Episode ID, plus the participant ID, the server error code and the trace or request ID from a failed join. In the API log or Sync trace dataset, run `| search "<episode-id>"` and then narrow by Tenant, Space, participant or trace ID. To see everything one device did, including requests before the join and across several joins, filter `['session.id'] == "<session-id>"` in both datasets. A user can quote the session ID from Call details or a problem report.

A missing failure report does not prove success. A worker can lose its lease or its API connection before it reports. Join recording events by operational job and worker attempt, not by Tenant or Episode.

## Rules for new telemetry

A terminal failure, rejection or timeout must say why, in a bounded and redacted form ([coding standards](../CODING_STANDARDS.md)).

- Tags and metric attributes use a fixed, small set of values. A metric never carries an Episode, Tenant or Participant ID. Put the ID in a log line and search the log.
- A caller is named by its matched `route` pattern, never by an ID. `chalk.api.participant_media.authentication` carries `outcome`, `reason` and `route`, and the log line `participant_media.authentication` adds the `trace_id` that leads to the `http.request` line with the path.
- Counters in the production metrics dataset are cumulative: each export repeats the running total. Read them with `prom::rate` or by the difference of the first and last point of a window. Summing the exported points counts every event once per export, so a counter stuck at 29 reads as 1,740 an hour.
- Allowlist error text. Provider descriptions, raw transport errors, SDP, URLs, paths and anything media-derived can echo hosts, addresses or content. Export a code class, a fixed phrase or a hash (`provider_message_fingerprint`, `participant_id_hash`) instead.
- Tokens, grants, authorization headers, tool arguments, transcript text and audio never enter a log, span or metric.
- Bound state kept for diagnostics (entries, bytes, age), and make a full or failed diagnostic degrade to silence. Diagnostics must never fail the user's operation.
- Count a decision once and name the outcome (`moved`, `refused_no_room`), so a rate shows what is wrong.
- Sample success, keep failures.

## Journey ledger and proof

Add a ledger event when a durable lifecycle boundary changes: the Episode, a participant, a publication, a recording, a webhook delivery. Do it in the same transaction as the change, link it to the parent event, and carry trace and span IDs. The webhook events are listed in `contract/webhooks/v1/journey-events.json`. MCP adds no parallel ledger. A capture claim writes `recording.claimed` to the Recording's start journey in the claim transaction, with `claim_lag_ms` and `placement`, so a slow start reads off the Episode's own timeline.

Do not add a ledger event for transient delivery that the client observes, such as a congestion pause, a retry, an ICE detail or a diagnostic sample. Their evidence is logs, metrics and call stats. Telemetry from the SFU cannot replace durable Postgres lifecycle evidence.

When a lifecycle boundary changes, update the ledger and the executable proof in the same change. The proof is a test that drives the real journey and checks the ledger rows, the trace correlation and the redaction. A success path alone is not enough: check that a rejected or failed report emits no success evidence.

## Diagnose one call

`pnpm diagnose:call <episode-id>` reads the database, the API, client and SFU log dataset, and the Sync trace dataset for one Episode, and joins every row by id (Episode, connection, journey, trace). It prints a verdict, a summary, a timeline for each Participant and a list of missing data. Each timeline step names its stage, the side that owns it (client, API, Sync, SFU or recorder, or unknown when the rows do not say) and the ids of the rows that prove it. It needs `AXIOM_TOKEN`, `AXIOM_ORG_ID`, `CHALK_LOG_DATASET`, `CHALK_TRACE_DATASET` and a read-only `CHALK_DATABASE_URL`.

A source it cannot read is a gap, never a silent omission. When no rule finds a failure and a source is missing, the verdict says "Not enough evidence" and names the source. `--strict` exits 3 when it finds a bad call and 2 when it found none but evidence is missing. The thresholds are in `infrastructure/observability/production-alerts/call-verdict.json`. A new event needs a rule in `scripts/diagnose-call/rules.mjs` and, to read well, a line in `scripts/diagnose-call/timeline.mjs`. CI runs the checker's tests when those files, or the code that writes the rows it reads, change.

## Client telemetry

Every SDK client reports what it saw of its own calls to one route, `POST /v1/tenants/{tenant_id}/telemetry`, and the API logs one Axiom row per event with `event = "sdk.telemetry"`. The body is `{ version: 1, client_session_id, events: [...] }`, at most 100 events and 64 KiB. A client session is one run of the SDK on a device, and its events carry a `seq` that counts up from 0 and `elapsed_ms` since the session began, so a gap in `seq` is loss that the server can see. Started events (a join started, the device went offline, the page was hidden) are sent at once, so the server learns of an abandoned join or a lost connection even when the client never sends its end.

The credential is the participant's media credential, the earliest one the join holds. The API accepts it until it expires, including after the participant leaves, because it only stamps rows and the byte budget bounds it, so no new token type or scope exists. The tenant, Space, Episode, participant, provider and `provider_session_id` on a row come from the credential, never from the body. The body carries only closed labels and bounded numbers: an event with an unknown field, a label outside its list, a number outside its range or a field its type does not allow is rejected alone, logged as `sdk.telemetry.rejected` with a fixed `reason`, the `type` and the `seq`, and counted in the response (`{ accepted, rejected }`). The rest of the batch is kept. Tokens, SDP, device labels, addresses, free text and audio content cannot pass.

Each participant has one budget of 4 MiB of request bytes, which refills over 135 minutes. It holds a 135-minute, six-person call with room to spare, and sibling paths share it: a batch costs its bytes whether its events are valid or not. A refused batch gets 429 with `Retry-After` and is logged as `rate_limit.exhausted` with the policy `v1.telemetry.intake`.

| Row field | Meaning |
| --- | --- |
| `type` | The event type. The closed list is `sdktelemetry.EventTypes()`. |
| `seq`, `elapsed_ms` | Order and client monotonic time. |
| `client_session_id`, `received_at` | The client session, and the server's receive time of the batch. |
| `state`, `step`, `outcome`, `code`, `phase`, `mechanism`, `attempt`, `duration_ms`, `outage_ms`, `heartbeat_gap_ms`, `close_code`, `http_status` | Join, state and recovery steps. `mechanism` is `ice_restart`, `media_reconnect`, `sync_reconnect`, `sync_digest` or `access_refresh`, and `outage_ms` is how long the media or Sync was down. A join is `space_join_span` with `outcome` `started`, `succeeded`, `failed` or `cancelled`. |
| `media_error_kind`, `media_error_step`, `granted_audio`, `granted_video`, `source`, `publication_state`, `projection_state`, `receive_state`, `track_state`, `element_state`, `play_result`, `receive_counts`, `receivers_stopped`, `bundle_tag_held`, `upload_failure` | Media paths and chat uploads. |
| `end_reason` | On `call_ended`: `left`, `episode_ended`, `time_limit`, `removed`, `connection_lost`, `join_failed` or `page_closed`. |
| `platform_state` | On `platform_changed`: `online`, `offline`, `hidden`, `visible`, `background` or `foreground`. |
| `action`, `op_id` | On `media_intent` and `media_result`: `mute`, `unmute`, `publish`, `unpublish`, `subscribe`, `unsubscribe`, `share_start` or `share_stop`. The result's `duration_ms` is the click to the acknowledgment, and `op_id` is the id the SFU logs for the same operation. |
| `error_name`, `device_kind`, `permission_state` | On `device_failed`: the DOMException name, the kind of device and the permission state. |
| `render_cause` | On `render_crashed`. |
| `dropped` | On `telemetry_dropped`: how many events the client's outbox lost to its byte bound. |
| `window_ms`, `gap`, `connection_type`, `rtt_ms`, `send_*`, `recv_*`, `freeze_*`, `tracks` | On `call_stats`: one window of stats. A window with `gap` (`offline`, `hidden`, `poll_failed` or `dropped`) measured nothing and has no other stat, and its `window_ms` is how long it lasted. It is never zero-filled. `tracks` holds, for each remote track, the `mid` the SFU logs, `kind`, `packets`, `lost`, `audio_energy` in thousandths of the browser's unit and `playout`. |

A window with `window_ms` between 1 s and 60 s is measured. Check `samples` before you trust a percentile, because each window covers about 30 seconds. `recv_paused_videos` rising with low receive bitrate means the Chalk SFU is protecting audio on a slow link, not a receive stall. `recv_hidden_videos` rising with low receive bitrate means the viewer's own tab or tile hid the video, which sends nothing on purpose: the SDK pauses or closes a hidden video after 5 s (15 s for a hidden page) and brings it back when the tile shows again.

To compare providers after a cutover step, or when a failure points at one provider:

```apl
['<api-log-dataset>']
| where ['attributes.event'] == "sdk.telemetry" and ['attributes.type'] == "call_stats" and isnull(['attributes.gap'])
| extend provider = iff(tostring(['attributes.provider']) in ("cloudflare_sfu", "chalk_sfu"), tostring(['attributes.provider']), "unknown")
| summarize
    samples = count(),
    rtt_p50 = percentile(todouble(['attributes.rtt_ms']), 50),
    rtt_p95 = percentile(todouble(['attributes.rtt_ms']), 95),
    recv_loss_p95 = percentile(todouble(['attributes.recv_loss_pct']), 95),
    freeze_rate = sumif(todouble(['attributes.freeze_count']), isnotnull(['attributes.freeze_count'])) / count()
  by provider
```

Add `['attributes.connection_type']` to separate relayed calls from direct ones, or `bin(_time, 1h)` for a trend. Nothing pages on this query.

**Completeness of one client session.** Group the rows by `client_session_id`. The first `seq` should be 0 (a later first `seq` lost the start), the `seq` values should have no gap (each gap is loss: a refused batch, a `telemetry_dropped` count, or a client that died before it sent), and the last event of a clean session is `call_ended`. A session with `join` `started` and no later join event is an abandoned join. After a leave, the client may still send until its credential expires, so wait five minutes before you call a session cut short.

A failed chat file upload is `chat_upload_failed`, with `upload_failure` naming where it broke: `initiate_failed` or `finalize_failed` (an API error), `storage_rejected` (storage answered with `http_status`), or `storage_unreachable` (the browser got no HTTP answer from storage: a network failure or a CORS block). `storage_unreachable` from a browser that otherwise works means the bucket CORS rule is wrong.

SDKs from before client telemetry (mobile 3.0.6 and older embedders) still post to `/connection-reports` and `/call-stats`. The API translates their reports into the same rows, numbers their events in the order listed, and marks each row `legacy_route`. Both routes and their translators are deleted when those SDKs are gone.

## Follow one Participant through the Chalk SFU

The Chalk SFU ships its logs over OTLP to the dataset the API's logs go to (`service.name=chalk-sfu`), so a bad call is explained without SSH. Every event carries `event` (also the log body), `tenant_id`, `episode_id`, `participant_id`, `generation`, `connection_id`, `session_kind` and `node_incarnation`. When the API sends `traceparent` and `X-Chalk-Journey-ID` on a control request, the session's later events carry `trace_id` and `journey_id`; a malformed header is ignored. Only these events leave the node, by an allowlist in `features/media/sfu/internal/telemetry/export.go`: a record exports when its `event` names a row, with that row's fields only, and each field declares its source (server-assigned, enum, number or restricted id), and a value a Participant or peer chooses, such as an SDP `rid`, is mapped to an enum first, with the raw value left in the journal. Error strings, the standard library's own diagnostics (a TLS error names the peer address) and every other line stay in the node's journal, so an event reports a cause code, never the error text. A new event or field needs a row in that table, and a test fails until it has one.

The events and their fields are the tables in `features/media/sfu/internal/media/events.go`; the notes here add what the values mean. The events are `sfu.session.registered`, `sfu.session.refused` (`code`), `sfu.admission.refused` (`reason`), `sfu.peer.state`, `sfu.ice.state` (with `path` once connected), `sfu.dtls.state`, `sfu.publication.started` and `.stopped`, `sfu.subscription.started`, `.stopped`, `.paused`, `.resumed` (`reason`), `.layer` (`layer`: `high`, `low`, `single` or `other`) and `.congestion`, `sfu.camera.plan`, `sfu.source.lease_opened` and `.lease_lost` (`cause`), and `sfu.session.closed` (`cause`, the first cause to reach the session). A source lease that only expires logs no event; its subscribers show `reason=source_unauthorized` in `/inspect`.

```apl
| where ['episode_id'] == "<episode-id>" and ['service.name'] == "chalk-sfu"
| where _time between (datetime(<from>) .. datetime(<to>))
| project _time, event, participant_id, connection_id, state, cause, reason, path, source, layer, trace_id
| sort by _time asc
```

Drop the `service.name` filter to see the API's and the SFU's lines together. Deploy installs the export when `~/.config/chalk-sfu/<env>/otlp-log-headers` exists (see the [SFU README](../features/media/sfu/README.md)); without it the node logs to its journal only.

## What an alert means

The rules, thresholds and delivery setup are in [production alerts](../infrastructure/observability/production-alerts/README.md). The Chalk SFU on-call steps are in its [runbook](../infrastructure/observability/production-alerts/sfu-runbook.md). The listener audio check is in [its README](../infrastructure/listener-audio-alert/README.md). The judgment behind them:

- **TURN credentials fail.** The join continues on STUN only, so clients on UDP-blocked networks cannot connect media. One failed mint is a blip, so the monitor pages on three in five minutes. Find the affected class by searching the log for the Episode ID.
- **Chalk SFU recovery refused.** A live Episode on a silent or restarted node moves through one generation-fenced binding change. A sustained `refused_*` outcome means live calls cannot leave a lost node, so check pool capacity first. A single `moved` is still worth a look at the lost node.
- **Retirement debt stuck.** A moved or ended Episode owes a retire to each node it left. The Episode end counts as confirmed once the debt row is durable, not when the node acknowledges. A healthy fleet pays a debt within seconds, so a debt older than 15 minutes means a node has stayed silent through many backoff cycles. Check that node, and restart it if it is up but not answering control calls. A silent node keeps its sessions until it restarts, but media stops within the source lease TTL because the API stops renewing the lease.
- **Sync stays unready.** Sync's own probes already apply hysteresis, so paging on each probe would be noise. The rule needs three unready minute samples in four, so a total outage turns the monitor red about three to four minutes after Sync stops. It ignores a short blip and catches a sustained outage, and it repeats every 30 minutes while it stays red. Missing samples do not prove continued unreadiness, so a lost host is caught by the freshness monitor, which turns red when a rule wrote no row for three minutes and names the rule. The collector also writes `database-unreachable` (the one row that still carries the failure when the database is down) and `runtime-health` (the API and the tunnel, as the host watchdog checks them), and the API `/readyz` body reports `sync` (`connected` or `disconnected`) without changing its status.
- **Listener audio.** An unpulled publication (Cloudflare SFU only) or `audio_receive_stuck` client reports from at least two distinct participants on one Episode page Oncall. The client report is the provider-neutral signal. Point `CHALK_AXIOM_LOG_DATASET` at the production API log dataset only: the query does not filter by environment, so a dataset that also holds nightly logs would page for nightly.
- **Connection-report rules.** They alert on one affected participant per Tenant, Episode and failure. A cleared threshold does not prove the person rejoined or recovered.

Process-local diagnostics, such as the listener publication sampler, reset on an API restart. A pull-acceptance signal proves the provider accepted the pull, not that packets arrived or renegotiation finished.

## Hosted MCP

`/mcp` uses the API's HTTP trace context, and each application call adds a child span named `mcp.<operationID>`. Look for `mcp.protocol.rejected` (schema or protocol failure) and `mcp.origin.rejected` (Origin denial). `mcp.oauth.*` events carry grant, tenant and client IDs only. A rise in `reuse_detected` means a client is racing refreshes or a token leaked.

## Transcription

Transcript failures carry a bounded `provider_*` reason (see `apps/transcription-dispatcher/src/errors.ts`) and never transcript text, provider bodies or audio. A silent source completes with no cues and no cost, so it is not a provider failure.

## Recording maintenance events

The API emits `recording.job_recovered` for each job that committed recovery returns, and `recording.reservation_expired` for each expired reservation. "Recovered" means the job row moved to a retry or a terminal failure, not that media was recovered. The `reason` is the committed row's code, not proof of which recovery predicate matched. The reservation event has no job ID, so join it to jobs by Recording ID. Events appear only after the enclosing transaction commits, and they never carry free text, payloads, leases, worker identity or storage paths.

## Recorder fleet conflicts

Expected recorder fleet 409 responses emit `recorder_fleet.operation_failed` at info level with `operation`, `error_code` and `http_status`. The codes distinguish inventory that is not ready, pending bootstrap and closed admission. A pending bootstrap with a validated diagnostic also carries its allowlisted `stage`; invalid or missing diagnostics omit it. These events carry no error text, request fields or node IDs. A conflict records a refusal or retry, not proof that a recording failed.
