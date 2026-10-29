# Production observability

API request logs and Sync event spans export to Axiom. Use W3C trace IDs and
Space or Episode IDs to correlate them. The private
`observability_journey_events` table holds the durable correlation record for
webhook and recording lifecycles.

## Follow an incident

Start with the Space and Episode IDs from the affected class and the participant
ID when available. Keep the server error code and trace/request ID from a
failed join when locating the corresponding request.
Tenant-level requests do not have an Episode ID.

In the relevant Axiom API log or Sync trace dataset, run:

```apl
| search "<episode-id>"
```

Replace the placeholder with the affected Episode ID. Narrow by Tenant, Space,
participant or trace ID where those attributes are present. API/Sync exporters
remain enabled through their managed OTLP configuration; dataset names and tokens
are private deployment inputs, not repository constants.

When a Participant joined without a knock, check the journey root named
`participant.admission_requested` in `observability_journey_events`. A backend
that asked for direct admission leaves `"admission": "direct"` in its
attributes. Policy admissions carry no `admission` attribute.

### Interrupted recording stops and missing provider tracks

A capture completed from retained bundles without a confirmed stopped callback
adds `recording.capture.salvaged` to the durable journey ledger in the same
transaction as completion. It links to the recording's start journey and parent
event when available, with the trace and span IDs of the current database
completion span. Legacy rows without journey metadata use the recording ID
as the journey ID. Its attributes contain only the recording ID, capture epoch,
`reason=stop_unconfirmed`, and `source=committed_bundles`. Confirmed stops do not
emit this event, and replaying a completed lease cannot emit it twice.

Pipeline maintenance also repairs a missing capture-stopped callback after durable
capture completion. It queues the existing `recording_capture_stopped` operation
under the original applied manual-stop authority and capture epoch, carrying that
stop's journey and parent-event IDs. Sync validates and commits its normal
`recording_status_changed` event; retries do not add another terminal event.
Episode end may adopt that same stop without replacing its authority. Neither
path commits an export or changes the successful capture job. The regression in
`apps/sync/test/chalk_sync/stateholder/postgres_lifecycle_test.exs` proves end retry,
callback recovery, and duplicate delivery against the Go controller and maintenance
commands.

For capture add-tracks responses containing `not_found_track_error`, API logs
retain `provider_response_snapshot` on `cloudflare_sfu.request_failed`; the
provider-failure span event carries `chalk.provider.response_snapshot`. This is
a projection of the documented response, capped at 4096 bytes and 16 tracks.
It preserves omitted identity fields and track order, hashes identity values,
redacts SDP and unknown error codes, filters descriptions, and drops unknown
fields. `omittedTracks` reports omitted entries. Use it to build a sanitized
fixture after a new occurrence; a documentation-based fixture alone does not
prove the shape of an earlier production failure.

### Background-tab and presence-expiry evidence

Every v1 `sync.websocket.closed` event includes `socket_age_ms` and
`heartbeat_gap_ms` alongside its existing close reason and verified Tenant,
Episode IDs and a SHA-256 `participant_id_hash`, not the raw participant ID.
Ages use the server's monotonic clock. A null
heartbeat gap means no application ping was observed before the socket closed.

The API's `participant.presence.expire` span and the durable
`participant.connection_expired` journey root carry the Tenant and Episode IDs,
the same participant hash, and an
`expiry_path`. `lease_expired` includes `last_seen_age_ms`, inferred from the
lease deadline minus the existing 120-second renewal TTL. `missing_lease`
includes `joined_age_ms` instead: there was no observed heartbeat to age.
The span's `reserved` attribute distinguishes a successful reservation from a
failed attempt; only a committed transaction retains the durable journey root.
No token, raw participant or user identity, error text, or media payload is added.

## Alerts

Three Axiom monitors cover API errors and abnormal Sync drops, failed/overdue
recordings and transcripts or exhausted webhooks plus terminal SDK connection
reports, and stale collector state. The connection-report rules alert on one
affected participant per Tenant, Episode and failure in ten minutes, evaluated
every minute. Messages include the first report's PKT time; a cleared threshold
does not prove the person rejoined or recovered. Persistent media-projection
mismatches also group by microphone/camera source and show publication/projection
states, duration and attempt. The mismatch rule matches nothing until the SDK/API
emit accepted `media_projection_mismatch` reports.
The read-only collector and Discord message templates live in
[infrastructure/observability/production-alerts](../infrastructure/observability/production-alerts/README.md).
The minute-based collector also emits `recording-stop` counts per Tenant when
Sync still reports `stopping` more than two minutes after pipeline capture
completion. Successful capture jobs still count. Any nonzero latest snapshot
newer than five minutes alerts on the next evaluation. A zero snapshot clears
the alert after callback recovery. This rule detects blocked Episode end and
new Episodes in the same Space without changing lifecycle or retry behavior.
The PostgreSQL fixture in `infrastructure/observability/production-alerts/collector_test.go` checks stranded,
recent, incomplete, healthy, and cross-Tenant rows and clearing after repair.
An independent uptime Worker checks API/Sync health and readiness and reports
failures directly to Discord.

### Sync lifecycle readiness evidence

When `/readyz` reports `lifecycle_intent_lag`, its cached dependency snapshot
retains the database observations from that failed probe. `database.lifecycle_intents`
reports pending, due, and retrying counts, plus the oldest lag-eligible intent's attempt
count and allowlisted error code (`other` for unknown codes; `null` before a failure).
Unattempted participant joins age from `next_attempt_at`, when their held seat is
due to expire, not from creation. Before that time they count as pending but do
not contribute lag. Intentionally unscheduled joins use `infinity`; they remain
pending but contribute neither lag nor due work. Other intents and attempted joins
still age from creation, including scheduled retries, so retry backoff cannot hide stuck work. The legacy
`oldest_pending_lifecycle_intent_ms` field reports this lag age; the oldest intent's
diagnostics use the same ordering and are null when no pending work is lag-eligible.
Use these fields to distinguish undiscovered backlog from repeated delivery failures;
they do not establish the underlying cause of a `dependency_unavailable` result.
The response contains no intent, Episode, participant, or Tenant identifiers.
Readiness thresholds, retry scheduling, and the one-second query timeout are unchanged.

Each failed probe check emits `sync.readiness.failed` through Sync's existing
observability telemetry and short-span path, plus a warning-level JSON journal
line. It records the check and reason, measured database values and limits or
consumer freshness/failure counters where available; unavailable dependencies
report `observed=false`. Exceptions and exits record only their category, never
the raw error text. These are probe observations, before readiness hysteresis.

Database query failures also record `query_stage` (`role`, `migration`, `pending_age`,
or `replication`), `error_class`, and SQLSTATE when available. SQL text, parameters,
connection details, and database error messages are not recorded. Query errors
still report the public reason `database_unavailable`.

For lifecycle lag, the journal and trace also contain the oldest currently due
intent's ID, kind, ISO-8601 due time and attempt count from the same database
snapshot as the lag measurement. This is separate from the oldest lag-eligible
intent, which can be a retry whose next attempt is still in the future. If there
is no due intent, the event reports `oldest_due_intent=none`. These identifiers
are log/trace-only; `/readyz` remains identifier-free. Tokens, payloads, participant
and Tenant identifiers, display names, request keys and raw error text are not
included.

### Sync connection failures

`sync.websocket.handshake` records `client_ip` (the edge's `CF-Connecting-IP`,
validated as an IP, or the direct peer) and a `user_agent` bounded to 512 characters.
The edge must replace the IP header before forwarding requests to Sync.
`sync.websocket.authenticated` adds verified `tenant_id`, `participant_id`, and
`episode_id`; close events retain those fields even if recovery fails after hello.
These lifecycle events include their structured fields in stdout as well as spans.
`close_code` is null until a server close is selected. Bandit does not expose the
peer's close frame to WebSock; peer codes remain null rather than guessed.
Invalid UTF-8 User-Agent values become null before JSON logging; valid values
remain bounded to 512 characters. No token, authorization header, or request URL
is retained.

The client retains `stage`, `opened`, `closeCode`, `closeReason`, and `durationMs`
in `failure.sync` and connection diagnostics. The failure reference shows the same
short summary. Before `open`, `stage=upgrade` means the opening handshake is pending;
browser WebSocket APIs do not reveal DNS, TCP, or TLS progress. After `open`, the
startup stage is `hello` (including initial recovery). Unknown peer reasons become
`redacted`; only fixed protocol reasons are retained. Pre-open failures use `connection.sync_start_failed`; `connection.sync_hello_timeout`
is reserved for startup after open. A pre-open close adds `cause=closed_before_open`
to the reference. `attempt=N` is the one-based socket attempt since Sync started.
Its duration measures that socket attempt, not the whole join. The final failure
also includes `attempts=N`, the total dials started, including any pending retry.
A pending retry retains the last completed failure until it opens or fails.
Browsers do not expose the HTTP rejection status or distinguish a network failure
from an edge rejection; an empty reason must not be labeled as a server timeout. Internal diagnostic event names such as
`sync_connect_failed`, `sync_dial_timeout`, and `connection_failed` identify
telemetry events, not public error codes. Retries can still succeed within the
startup budget.

### Automatic browser connection reports

The TypeScript Connection SDK keeps the latest 64 connection events in memory
from construction, without installing a recorder. A failed join, terminal
connection failure, or exhausted recovery freezes one report and posts it to
`POST /v1/tenants/{tenant_id}/connection-reports`. Successful joins, normal leaves,
and successful recovery do not upload it. Sync socket opens/closes include codes
and timings; heartbeat gaps, join steps, media state/HTTP failures, and recovery
attempts use only known labels and bounded numbers. Cloudflare SFU uses HTTP
signaling and WebRTC, not a media WebSocket.

Both transports default to a 60-second foreground recovery budget. Recoverable
media failures retry throughout that budget, with default delays of 1, 2, 4,
then 6 seconds (custom delays cannot shorten that ramp or exceed 6 seconds);
the Sync attempt cap does not shorten media recovery. Only then does media emit
`media_recovery_exhausted` and continue retrying in the background while Sync
stays connected. Rejected media access requires an explicit rejoin rather than
automatically replacing another connection's seat. Before declaring rejection
terminal, the SDK checks the primary Episode lifecycle through a participant's
signed, route-bound status read. `ending` or `ended` takes the normal ended
path even when SFU 401/403 or close-tracks 410 precedes the Sync end event;
an active Episode keeps current-binding revocation terminal. A local End in
flight settles first. Unavailable status reads keep Sync running and retry
without requesting a replacement binding; a late read cannot fail a newer binding.
Normal end emits no `connection_failed` report. End/rejection races are covered
in `sdks/typescript/client/src/connection/episode-end-race.test.ts`. The timing and rejection
regressions are covered in
`sdks/typescript/client/src/connection/media-recovery.test.ts`.

Automatic replacement forwards `expectedMediaConnectionId` through the browser
access context and the server SDK's refresh request. The API compares the
corresponding `expected_media_connection_id` against the current binding before
and after issuing credentials; a takeover returns HTTP 409 with
`participant.connection_superseded`, which requires explicit rejoin. Requests
without this optional field keep the legacy replacement/takeover behavior, so
the API can deploy before the SDK. A lifecycle attempt uses its fresh binding
without an additional inner replacement; fast failures produce at most twelve
replacement grants and track requests in the default foreground minute.
Recovery also forwards the browser's `currentMediaToken` for the existing
encrypted replay mechanism. A lost response replays the committed grant only
while its replacement binding remains current; a later takeover invalidates it.
Never log the credential or substitute another tab's backend-retained token.
An identical conditional request still being issued returns HTTP 409 with
`participant.media_replacement_pending`. The SDK treats this as temporarily
unavailable, keeps Sync/media recovery alive, and retries with the same
credential and expected binding. Pending retries allocate no additional SFU
session; only another binding's takeover returns the terminal superseded code.

Failed media acquisition/start spans and media recovery reports include
`media_error_kind` (allowlisted DOMException name, `CloudflareSFUError`,
`network`, `timeout`, or `unknown`) and `media_error_step` (`local_capture`,
`peer_connection`, `access_refresh`, `sfu_tracks`, `sfu_close_tracks`, `sfu_renegotiate`, or
`sfu_publications`). SFU HTTP failures also carry `http_status` (400–599).
`network` identifies a fetch rejection or browser NetworkError, not an arbitrary
TypeError. `granted_audio` and `granted_video` are `granted`, `not_granted`, or
`unknown`: live tracks returned by acquisition, regardless of mute state, not
the requested intent. Fallback capture can grant only one kind. Before
acquisition completes these fields are `unknown`. Recovery retains the original
acquisition result, not a new permission query. Unclassified failures stay
`unknown`; no raw error text is serialized.
Deploy the API allowlist before shipping an SDK that emits these fields; older
APIs reject unknown report fields.

The API validates a maximum 32 KiB body and 64 events, rejects unknown fields and
labels, and authenticates the participant media credential against the route's
Tenant. It deliberately does not require an active participant or passing Sync
readiness: those can be the failure being reported. Identity comes exclusively
from that verified credential. The `sdk.connection_report` warning includes
`tenant_id`, `space_id`, `episode_id`, SHA-256 `participant_id_hash` (the same
format as presence expiry and Sync close events), `trigger`, and a compact JSON
string in `report`. Its `trace_id` shares the SDK's W3C parent with Sync hello and
media signaling. Parse `report` as JSON when querying the API log dataset.
An own microphone/camera publication that disagrees with the Sync projection for
two seconds triggers `media_projection_mismatch`.
Its event includes allowlisted `source` (`microphone`/`camera`), `publication_state`
and `projection_state` (`on`/`off`), mismatch `duration_ms`, retry count in `attempt`,
and `outcome` (`started`/`failed`). Publication IDs and device labels are excluded.
The monitor never sends a self-media target. Its `attempt` is always zero.
After the ten-second grace, unconfirmed live capture is paused locally before
failure is shown. Only a new user action can enable again; changing publication
identity cannot extend the grace or restore capture. Projection-on without own
live capture is reported once but left alone: it may belong to another client of
the same participant. OS microphone interruptions also pause only local capture.
Recovery retains
old intent revisions across Sync replacement, including unconfirmed publications.
A recovered off/missing source requires a new user action. Moderation control
revisions order stops against user actions, including capture still awaiting permission.
The existing report cooldown also applies to these reports.
Receiver projection gating remains unchanged: bypassing it would defeat moderation.
Rejected reports emit `sdk.connection_report.rejected` with the same trace ID
and verified participant hash, plus a bounded `reason` identifying the failed
schema, label, ordering, size, or range check. Rejected values, bodies, and decoder
error messages never enter the log.

There are no tokens, names, emails, IP addresses, URLs, peer close reasons, error
messages, media contents, or arbitrary payloads in the report body. The SDK
allows one report per participant per minute across connections in the same
module instance; the API enforces six per participant per ten minutes through
its existing limiter. The SDK holds one pending report while offline, retries a
transport failure once on a later browser `online` event, bounds each upload to
five seconds, and discards it on disposal. An `online` event during an active
upload is retained for that retry if the upload subsequently fails. An HTTP response, including rejection,
is final. Reports are best effort: closing/reloading the page, expired credentials,
or failure before obtaining a signed access grant can prevent delivery. Diagnostics
do not request credentials, change call recovery, or use persistent storage.

The automatic capture and authenticated report contract add about 1.3 KiB of loaded
compressed JavaScript. The call fixture and production-route JavaScript caps allow
2 KiB for this feature; timing, CSS, and lifecycle-leak limits are unchanged.

Reproduce both a join failure and a full 60-second offline drop against the local
API/Postgres/Sync stack (only remote vendor services are fixtures) on Instabox:

```sh
box run -- 'sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client && bash scripts/gates/instabox-run.sh --browser env GOMAXPROCS=1 ERL_FLAGS="+S 1:1" DASHBOARD_ENGINE_DEADLINE_SECONDS=600 bash apps/web/tests/dashboard/real-engine.sh pnpm --filter web exec node tests/dashboard/connection-reports-browser.mjs'
```

The proof writes allowlisted evidence under `artifacts/connection-reports/`:
accepted API report log lines, matching Sync close evidence, the actual report
bodies, and trace correlation. It checks reconnect delivery, caps/redaction,
normal-call silence, and clean rejoin. The harness owns and stops its browser,
servers, and disposable database.
