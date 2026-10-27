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
Episode and participant IDs. Ages use the server's monotonic clock. A null
heartbeat gap means no application ping was observed before the socket closed.

The API's `participant.presence.expire` span and the durable
`participant.connection_expired` journey root carry those three IDs and an
`expiry_path`. `lease_expired` includes `last_seen_age_ms`, inferred from the
lease deadline minus the existing 120-second renewal TTL. `missing_lease`
includes `joined_age_ms` instead: there was no observed heartbeat to age.
The span's `reserved` attribute distinguishes a successful reservation from a
failed attempt; only a committed transaction retains the durable journey root.
No token, participant name or media payload is added.

## Alerts

Three Axiom monitors cover API errors and abnormal Sync drops, failed/overdue
recordings and transcripts or exhausted webhooks, and stale collector state.
The read-only collector and Discord message templates live in
[infrastructure/observability/production-alerts](../infrastructure/observability/production-alerts/README.md).
An independent uptime Worker checks API/Sync health and readiness and reports
failures directly to Discord.

### Sync lifecycle readiness evidence

When `/readyz` reports `lifecycle_intent_lag`, its cached dependency snapshot
retains the database observations from that failed probe. `database.lifecycle_intents`
reports pending, due, and retrying counts, plus the oldest lag-eligible intent's attempt
count and allowlisted error code (`other` for unknown codes; `null` before a failure).
Unattempted participant joins age from `next_attempt_at`, when their held seat is
due to expire, not from creation. Before that time they count as pending but do
not contribute lag. Other intents and attempted joins still age from creation,
including scheduled retries, so retry backoff cannot hide stuck work. The legacy
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
