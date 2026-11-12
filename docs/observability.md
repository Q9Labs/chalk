# Observability

API request logs, API metrics and Sync event spans export to Axiom. The private table `observability_journey_events` is the durable correlation record for webhook and recording lifecycles. Code defines the event names, fields and metrics; search it (`apps/api/internal/observability`, `apps/sync`) instead of trusting a list here. This page keeps the rules and the reading judgment.

## Correlation

- Every operation is a trace and the request ID is the trace ID. Carry `traceparent` across every hop, including workers, the recorder and the dispatcher.
- A session is one run of a Chalk app on one device. The SDK sends it as W3C `baggage: session.id=<uuid>` on every API request and in the Sync `hello` frame. The API and Sync copy a valid lowercase UUID onto spans and logs and ignore anything else. It is never an Episode, a Cloudflare session or a dashboard `sessionId`. It is not written to the ledger, to Sync frames sent back, or to durable rows.
- Every API response names its request in the `x-chalk-journey-id` header, which CORS exposes. The same ID is `journey_id` on the request log line, on logs and spans started under the request, and on the ledger rows it writes. The client never sends one: the ledger keys one lifecycle by its journey ID, so an ID shared by a session would merge unrelated joins and recordings. Follow a device by `session.id` and one failure by its journey ID. The SDK keeps the latest failed response's journey ID (`lastFailedRequest`), and web problem reports print it as `Last failed request: <journey id> (HTTP <status>)`.
- The `http.request` log line carries `route` (the matched pattern, `unmatched` when none), `status`, `tenant_id` when the route has a valid `{tenant_id}`, and `error_code`, the public API code of a failed response, so a 403 or 409 names the rule that refused it. When a provider's refusal sits behind another public status, the line and the `http.failure` line add `upstream_status` and `upstream_code`; a code that is not a short lowercase token is logged as `unsafe`. The server span and the `journey.phase.http` span carry `http.route` and `tenant.id`: group latency by `http.route`, never by path.
- A request that carries a participant media credential (every `/media/sfu` route) adds `episode_id`, `participant_id_hash` (the same SHA-256 hex `sdk.call_stats` logs) and `provider` (the media plane that serves the Episode) to its `http.request` and `http.failure` lines, and `episode.id`, `participant.id_hash` and `chalk.media_plane.provider` to its server and journey spans, so a trace joins to an Episode and a plane. `media.connection_replacement` and `media.track_close` carry the same three fields. All of them also carry `connection_id` (span attribute `chalk.media.connection_id`), the media connection the credential is bound to: the own SFU logs the same value as `connection_id` on every node event, `sdk.call_stats` and `sdk.connection_report` carry it too, and `participants.media_connection_id` holds it while the connection is current. For the own SFU `connection_id` and `provider_session_id` are one value. For Cloudflare the plane's session id is `provider_session_id` and `connection_id` is still the id Chalk issued, so `connection_id` joins an SDK row, an API line and (on the own SFU) a node event on every plane. `participant_media_refreshes` is not a join table: it keeps one replay row per credential refresh for a few minutes and deletes the row it displaces, so it is empty whenever no refresh is in flight. The own-SFU adapter opens a `mediaplane.chalk_sfu.<operation>` client span per call, like the Cloudflare adapter's `mediaplane.cloudflare.sfu.<operation>`, so a trace shows which plane served it.
- A close-tracks request carries `reason` (`user_mute`, `unpublish`, `replacement`, `leave` or `error`); `media.track_close` logs it as `close_reason`, or `unspecified` from an older client. The Cloudflare `cloudflare_sfu.add_tracks` log carries `session_track_count`, the tracks the provider reports on the session after it rejected the call (`-1` when the call succeeded or the read failed).
- The API logs `previous_exit` on `api starting`: `clean` when the last process stopped through its shutdown path, `unclean` when it started and never finished stopping, `unknown` when no marker survived. The marker is a file in the host's temp directory, so a new host, container or cleared temp directory reads `unknown`, and the host-level cause of an `unclean` exit is found in the host's own logs.
- The API injects `traceparent`, never `baggage`, into its calls to the own SFU and into webhook deliveries, so the session ID stays inside Chalk.
- Deploy the API and Sync before the SDK, and keep `Baggage` in the API's CORS allow list. An older Sync rejects a `hello` that carries baggage, and the SDK then retries once without it.
- Dataset names, tokens and monitor IDs are private deployment inputs. This repo is public, so keep them out.

## Diagnose one call

`pnpm diagnose:call <episode id>` reads the API and client log, the SFU node events, the Sync spans and the database for one Episode, joins every row by id, and prints in one run: a verdict line (who, what they lived through, from when to when, the failing stage, whose side it is and the cause), a timeline across client, API, Sync and SFU, the evidence that is missing, how many rows each source gave and how many joined by id, the places where time still matters, and the elapsed seconds. It needs `AXIOM_TOKEN`, `AXIOM_ORG_ID` and `CHALK_LOG_DATASET`; `CHALK_TRACE_DATASET` (Sync spans) and `CHALK_DATABASE_URL` (Participants and join times) are optional and their absence is listed as missing evidence. `--fixture rows.json` runs the same rules on saved rows, and `--strict` exits 2 when a row of the call cannot be reached by id.

- **Join keys.** The Episode id, the hashed Participant id, one connection id that the SDK, the API and the SFU node all write (the node's `provider_session_id` is the same value), and the journey or trace id. A row with none of them is reported as unjoined, and a test fails when a fixture row of a call cannot be reached by id.
- **Bad call.** The rules live in `infrastructure/observability/production-alerts/call-verdict.json`: a failed join, media silence over 5 s with a sender sending and the receiver having taken media before, a Participant whose sender reports 0 kbps for over 5 s while another Participant reports stats, a viewer under 100 kbps for over 30 s (on a healthy link it is starvation; with loss, round trip or available bandwidth past the thresholds it is the viewer's network), or a connection replacement within 20 s of join. The command and the collector read that file and pass the same fixtures (`scripts/diagnose-call/fixtures/cases.json`).
- **Stage and side.** Each finding names the failing `stage` (a join step such as `wait_for_sync_live`, or `publishing`, `forwarding`, `receiving`, `reconnecting`) and the `side` that owns it: `publisher`, `viewer`, `SFU`, `API`, `Sync`, `client`, `network`, or `unknown` when the exported rows cannot say (for example an SFU node that exported nothing for the connection). A failed join takes its step from the client report's first failed `space_join_span`, or its code from the API refusal that shares the journey id. A node pause with reason `congestion` is the network and one with reason `viewer` is the viewer.
- **A viewer that hid its own video** is not a bad call. The SDK sends `recv_hidden_videos` in `sdk.call_stats` when a tile or page was hidden and it stopped receiving on purpose; a quiet stretch with that count above zero is reported as `viewer_hid_video` (side `viewer`, by choice), the collector does not flag it, and it is not read as silence or starvation. Before the SDK build that sends the field is released, the same rows read as silence.
- **Timestamps.** A time is never used to decide which rows belong to the call. The output lists each remaining use of time, for example placing a `call_stats` sample on a clock or picking the last node event before a problem ended.
- **Automatic flag.** With `CHALK_ALERT_AXIOM_QUERY_TOKEN` set, the collector judges each Episode 30 to 90 seconds after it ended and writes a `call-verdict <episode id>` row for a bad one. The first monitor alerts on it through the existing Discord and Oncall notifiers, with the verdict line and this command. See the [collector README](../infrastructure/observability/production-alerts/README.md#call-verdicts).
- **A cause of "unknown"** means the evidence for it was not exported: before a build that logs `connection_id` and the node events is deployed, the command names the Participant and the window but not the cause, and says which source is missing.

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

Add a ledger event when a durable lifecycle boundary changes: the Episode, a participant, a publication, a recording, a webhook delivery. Do it in the same transaction as the change, link it to the parent event, and carry trace and span IDs. The webhook events are listed in `contract/webhooks/v1/journey-events.json`. MCP adds no parallel ledger. A capture claim writes `recording.claimed` to the Recording's start journey in the claim transaction, with `claim_lag_ms` and `placement`, so a slow start reads off the Episode's own timeline.

Do not add a ledger event for transient delivery that the client observes, such as a congestion pause, a retry, an ICE detail or a diagnostic sample. Their evidence is logs, metrics and call stats. Telemetry from the SFU cannot replace durable Postgres lifecycle evidence.

When a lifecycle boundary changes, update the ledger and the executable proof in the same change. The proof is a test that drives the real journey and checks the ledger rows, the trace correlation and the redaction. A success path alone is not enough: check that a rejected or failed report emits no success evidence.

## Reading call quality

The SDK uploads a WebRTC summary while a call is open: the first window closes 5 seconds after media starts and uploads at once, so the start of a call is not dark, and later windows are 10 seconds long, uploaded six at a time. A background tab's timers run about once a minute, so a window up to five minutes still counts; its `window_ms` reports at most 60 seconds, and the rates use the real length. Each row also carries the jitter buffer delay, NACK and PLI counts for send and receive, `recv_frames_dropped`, `quality_limitation` (`cpu`, `bandwidth` or `other`, the worst reason seen in the window, absent when none), the available incoming and outgoing bitrate estimates (`available_incoming_kbps`, `available_outgoing_kbps`) and `relay_offered` (whether the browser gathered a relay candidate, even when the selected path is direct). The browser counts a freeze only when frames resume after a gap, so a receiver that gets nothing used to read `freeze_count` 0 beside 0 kbps; a live, visible video whose decoded frames stopped (the `video_receive_stalled` check) now counts as a freeze and adds its stalled time to `freeze_ms`. A stream that appears inside a window counts from zero, so its first window keeps its inbound or send rate. The rows a Participant sent before this change lack these fields. Before this change the collector also dropped any window longer than 60 seconds, which is the likely reason a throttled tab uploaded few rows; whether that explains the Participant who had no inbound rows is not proved, because the production uploads cannot be replayed. The API logs each one as `sdk.call_stats` with the session ID, a hashed participant ID, the connection type (`udp`, `tcp`, `turn`), loss, jitter, RTT, freezes and the provider. `sdk.connection_report` carries the same `connection_id` and `provider_session_id`, so a report joins to its `call_stats` rows. The SDK also uploads the final batch when the page hides or closes, so a short call is no longer lost between uploads. `provider_session_id` is the connection ID the own SFU logs and returns from `/inspect`, so a device joins to the SFU's view of the same connection.

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

Check `samples` before you trust a percentile, because each sample covers about ten seconds. Add `['attributes.connection_type']` to separate relayed calls from direct ones, or `bin(_time, 1h)` for a trend. Nothing pages on this query.

A rising `recv_paused_videos` with low receive bitrate means the own SFU is protecting audio on a slow link. It is not a receive stall. A rising `recv_hidden_videos` with low receive bitrate means the viewer's own tab or tile hid the video, which sends nothing on purpose: the SDK pauses or closes a hidden video after 5 s (15 s for a hidden page) and brings it back when the tile shows again.

A failed chat file upload is reported as `chat_upload_failed` (trigger `upload_failed`) on the connection-report endpoint, with `upload_failure` naming where it broke: `initiate_failed` or `finalize_failed` (an API error), `storage_rejected` (storage answered with `http_status`), or `storage_unreachable` (the browser got no HTTP answer from storage: a network failure or a CORS block). `storage_unreachable` from a browser that otherwise works means the bucket CORS rule is wrong. The report needs an open call connection, so a chat outside a call does not report.

## Follow one Participant through the own SFU

The own SFU ships its logs over OTLP to the dataset the API's logs go to (`service.name=chalk-sfu`), so a bad call is explained without SSH. Every event carries `event` (also the log body), `tenant_id`, `episode_id`, `participant_id`, `generation`, `connection_id`, `session_kind` and `node_incarnation`. When the API sends `traceparent` and `X-Chalk-Journey-ID` on a control request, the session's later events carry `trace_id` and `journey_id`; a malformed header is ignored. Only these events leave the node, by an allowlist in `features/media/sfu/internal/telemetry/export.go`: a record exports when its `event` names a row, with that row's fields only, and each field declares its source (server-assigned, enum, number or restricted id), and a value a Participant or peer chooses, such as an SDP `rid`, is mapped to an enum first, with the raw value left in the journal. Error strings, the standard library's own diagnostics (a TLS error names the peer address) and every other line stay in the node's journal, so an event reports a cause code, never the error text. A new event or field needs a row in that table, and a test fails until it has one.

The events are `sfu.session.registered`, `sfu.session.refused` (`code`), `sfu.admission.refused` (`reason`), `sfu.peer.state`, `sfu.ice.state` (with `path` once connected), `sfu.dtls.state`, `sfu.publication.started` and `.stopped`, `sfu.subscription.started`, `.stopped`, `.paused`, `.resumed` (`reason`), `.layer` (`layer`: `high`, `low`, `single` or `other`) and `.congestion`, `sfu.camera.plan`, `sfu.source.lease_opened` and `.lease_lost` (`cause`), and `sfu.session.closed` (`cause`, the first cause to reach the session). A source lease that only expires logs no event, so the node counts it: `chalk.sfu.source.lease_lapses` is the leases that ran out without a renewal, and the gauge `chalk.sfu.subscriptions.source_unauthorized` is the subscriptions paused because their source holds no live lease (`reason=source_unauthorized` in `/inspect`). A lease that runs out also logs `sfu.source.lease_lost` with `cause=ttl_lapsed`, once per lease window, and the subscription it pauses logs `sfu.subscription.paused` with `reason=source_unauthorized` when the control loop first sees the pause and `sfu.subscription.resumed` (`was=source_unauthorized`) when it ends, so the pause has a start and an end in the log as well as a count. `sfu.subscription.layer` also carries `ceiling` (the highest layer the viewer asked for) and `server_limit` (the layer the node holds the subscription to, from the transport estimate or the Episode plan), both `high`, `low`, `single`, `other` or `none`.

Two questions decide most bad calls. "Why did forwarding stop" is answered by `sfu.subscription.paused` and `.resumed` (`reason`: `viewer`, `congestion`, `planner`, `source_inactive` or `source_unauthorized`), by `sfu.source.lease_lost` (`cause`: `revoked`, `newer_allocation` or `ttl_lapsed`), and by `sfu.session.closed` and `sfu.publication.stopped` for the publisher's side. "Why was this receiver on a starved layer" is answered by `sfu.subscription.layer` (the layer, the viewer's `ceiling` and the node's `server_limit`), `sfu.subscription.congestion` (the estimate behind a congestion pause) and `sfu.camera.plan` (the Episode's level). A receiver held to a low layer with `ceiling` high and `server_limit` low was held by the node; with `ceiling` low it asked for it; with both open and a low `layer`, the publisher sent no better layer. These events exist only on a node that runs a build with them, so confirm after each Promote that the production node exports them (`['<api-log-dataset>'] | where ['resource.service.name'] == 'chalk-sfu' | summarize count() by ['attributes.event']`); that check cannot be made before the deploy.

Time to first audio is measurable on both planes: the client reports `ice_connected` and `first_audio_bytes` (`duration_ms` since the media connection started, once per connection, `first_audio_bytes` to the 5 s sample interval) in `sdk.connection_report` summaries. `video_receive_stalled` reports a visible, live, unpaused video whose decoded frames stopped growing for 8 s.

```apl
| where ['episode_id'] == "<episode-id>" and ['service.name'] == "chalk-sfu"
| where _time between (datetime(<from>) .. datetime(<to>))
| project _time, event, participant_id, connection_id, state, cause, reason, path, source, layer, trace_id
| sort by _time asc
```

Drop the `service.name` filter to see the API's and the SFU's lines together. Deploy installs the export when `~/.config/chalk-sfu/<env>/otlp-log-headers` exists (see the [SFU README](../features/media/sfu/README.md)); without it the node logs to its journal only.

## Follow one Participant through Sync

Sync exports short spans to the traces dataset when `CHALK_SYNC_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` are set (service `chalk-sync`); without them it exports nothing, which is the first thing to check when Sync is missing from Axiom. Sync does not send logs. Every Participant event carries `tenant_id`, `episode_id` and `participant_id_hash` (the same SHA-256 hex the API logs), so a Sync span joins to the API's lines and to the SFU's events by Episode and Participant. No event carries message content, a token or a display name.

- `sync.websocket.handshake`, `sync.websocket.authenticated` and `sync.websocket.closed` (close code, phase, socket age and heartbeat gap) bracket every socket.
- `sync.participant.socket_up` and `sync.participant.socket_down` carry `live_sockets`, the Participant's live sockets after the change. `socket_up` with `live_sockets` above 1 is a rejoin that overlaps the old socket, or a second device. `socket_down` with 0 means the Participant is absent now; a lost socket is presence, not a leave.
- `sync.media.grant`, `sync.media.pause`, `sync.media.resume` and `sync.media.revoke` carry `source` (`microphone`, `camera` or `screen`), `outcome` (`confirmed`, `satisfied`, `retryable_failure`, `terminal_failure`; for a revoke also `pending`) and `error_code` when one failed. A revoke carries `operation`. A grant that fails, or a revoke that never confirms, shows here with its code.
- `sync.screen_lease.renew_failed` carries `error_code`.

The table `sync_media_pauses` holds the pauses in force and loses a row on resume. `sync_media_pause_history` keeps one row per pause with `paused_at` and `resumed_at`, written in the same transaction, so a pause that never resumed is a row with `resumed_at is null` on an Episode that went on:

```sql
select episode_id, participant_id, source, paused_at
from sync_media_pause_history
where resumed_at is null and paused_at < now() - interval '5 minutes'
order by paused_at;
```

Rows leave with the Episode (retention and `on delete cascade`).

## What an alert means

The rules, thresholds and delivery setup are in [production alerts](../infrastructure/observability/production-alerts/README.md). The own-SFU on-call steps are in its [runbook](../infrastructure/observability/production-alerts/sfu-runbook.md). The listener audio check is in [its README](../infrastructure/listener-audio-alert/README.md). The judgment behind them:

- **TURN credentials fail.** The join continues on STUN only, so clients on UDP-blocked networks cannot connect media. One failed mint is a blip, so the monitor pages on three in five minutes. Find the affected class by searching the log for the Episode ID.
- **Own SFU recovery refused.** A live Episode on a silent or restarted node moves through one generation-fenced binding change. A sustained `refused_*` outcome means live calls cannot leave a lost node, so check pool capacity first. A single `moved` is still worth a look at the lost node.
- **Retirement debt stuck.** A moved or ended Episode owes a retire to each node it left. The Episode end counts as confirmed once the debt row is durable, not when the node acknowledges. A healthy fleet pays a debt within seconds, so a debt older than 15 minutes means a node has stayed silent through many backoff cycles. Check that node, and restart it if it is up but not answering control calls. A silent node keeps its sessions until it restarts, but media stops within the source lease TTL because the API stops renewing the lease.
- **Sync stays unready.** Sync's own probes already apply hysteresis, so paging on each probe would be noise. The rule needs four unready minute samples in five. It ignores a short blip and catches a sustained outage. Missing samples do not prove continued unreadiness. The freshness monitor catches a stopped collector.
- **Listener audio.** An unpulled publication (Cloudflare SFU only) or `audio_receive_stuck` client reports (not `audio_receive_unbound`, a client that never bound an audio element: its bytes flow, so it proves nothing about audible audio) from at least two distinct participants on one Episode page Oncall. The client report is the provider-neutral signal. Point `CHALK_AXIOM_LOG_DATASET` at the production API log dataset only: the query does not filter by environment, so a dataset that also holds nightly logs would page for nightly.
- **Connection-report rules.** They alert on one affected participant per Tenant, Episode and failure. A cleared threshold does not prove the person rejoined or recovered.

Process-local diagnostics, such as the listener publication sampler, reset on an API restart. A pull-acceptance signal proves the provider accepted the pull, not that packets arrived or renegotiation finished.

## Hosted MCP

`/mcp` uses the API's HTTP trace context, and each application call adds a child span named `mcp.<operationID>`. Look for `mcp.protocol.rejected` (schema or protocol failure) and `mcp.origin.rejected` (Origin denial). `mcp.oauth.*` events carry grant, tenant and client IDs only. A rise in `reuse_detected` means a client is racing refreshes or a token leaked.

## Transcription

Transcript failures carry a bounded `provider_*` reason (see `apps/transcription-dispatcher/src/errors.ts`) and never transcript text, provider bodies or audio. A silent source completes with no cues and no cost, so it is not a provider failure.

## Recording maintenance events

The API emits `recording.job_recovered` for each job that committed recovery returns, and `recording.reservation_expired` for each expired reservation. "Recovered" means the job row moved to a retry or a terminal failure, not that media was recovered. The `reason` is the committed row's code, not proof of which recovery predicate matched. The reservation event has no job ID, so join it to jobs by Recording ID. Events appear only after the enclosing transaction commits, and they never carry free text, payloads, leases, worker identity or storage paths.
