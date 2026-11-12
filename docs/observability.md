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

### Recording render attempts

Every failed render attempt emits `recording.render_attempt_failed` with `job_id`,
`attempt_count`, `fencing_generation`, `error_code`, `error_detail`, and W3C
`trace_id` / `span_id`. The worker emits it before reporting failure; the API
emits it after accepting the fenced report, so it reaches the managed API log
exporter even when the disposable node has no log exporter. The worker sends
W3C trace context independently of global telemetry initialization. Only validated
`session.id` baggage is forwarded; unknown members and member properties are dropped.

`error_detail` emits only fixed internal diagnostic phrases, capped at 512 bytes.
Other text, including individual diagnostic words, paths, identifiers, numbers,
URLs, credentials, and media-derived text, is redacted. The private job row still retains the existing bounded diagnostic
error. No new durable journey event or lifecycle transition is introduced.
H264 with more than 512 variable frame intervals keeps every decoded frame's
timestamp in both copy and re-encode paths. Worker and API tests check accepted-failure evidence, trace correlation,
and redaction; rejected failure reports do not emit accepted-failure evidence.

### Recording maintenance transitions

The API emits `recording.job_recovered` for each job returned by committed
recovery, including recovery before a worker claim and background maintenance.
It carries `tenant_id`, `episode_id`, `recording_id`, `job_id`, `kind`, the resulting
`state`, `attempt_count`, `attempt_limit`, `fencing_generation`, and the row's
`transition_at`. Both pending retries and terminal failures appear; "recovered"
does not mean a recording or retained media was recovered.

`reason` permits only `recording_source_expired`, `render_deadline_exceeded`,
`capture_completion_expired`, `capture_stopped_before_completion`, and
`lease_expired`; other stored codes become `other`. Recovery can retain an older
error code, so the reason is the committed row's code, not proof of which recovery
predicate matched. `capture_outcome=stopped_before_claim` appears only for the
exact SQL marker with zero attempts. It does not explain why the Episode stopped.
No free-text error, payload, lease, worker identity, storage path, or media is logged.

`recording.reservation_expired` carries Tenant, Space, Episode, Recording and
reservation IDs, the resulting reservation `state`, `transition_at`, and fixed
`reason=capture_reservation_expired`. The expiry result does not contain a job ID;
join by Recording ID rather than guessing a job or its previous state.

Events appear only after the enclosing transaction succeeds, including webhook
writes. Failed or empty transactions emit no per-row transition event. A later
expiry error cannot hide already committed job recovery. The aggregate
`recording.pipeline_maintenance.completed` event remains unchanged. These events
use the caller's context and introduce no durable journey event or lifecycle change.
The focused diagnostics regression checks that private job fields stay out of logs.
Go compilation and vet check types and call signatures, not transaction behavior.

### Recording stopped callbacks

The API emits `recording.capture_stopped_callback` with `outcome=accepted` only
when the stopped callback service succeeds, even when successful HTTP request
logs are disabled. It includes the operational `job_id`, `attempt_count`,
`capture_epoch`, and `duration_ms` for the API service call. Acceptance does not
prove the worker received the response or the recording finished processing.

If the worker gives up, its existing `recording.capture_attempt_failed` report
preserves `stage=capture_stopped`, `outcome=returned` or `outcome=timed_out`, the
safe error class, HTTP status, API error code, `callback_attempts`, and
`callback_elapsed_ms`. The elapsed time includes callback calls and retry waits,
not local media shutdown. These fields survive the failure-detail sanitizer;
unknown text still does not. Join the two event types by operational job and
worker attempt, not by a Tenant or Episode identifier. A missing failure report
is not proof of success: the worker may have lost its lease or its API connection.

### Follow a user's session

A session is one run of a Chalk app on one device: a browser tab, or an app launch
on mobile. The SDK shows its ID in Call details as "Session ID" and adds it to
problem-report diagnostics, so a user can quote it. It is the OpenTelemetry
attribute `session.id`, never an Episode or a Cloudflare or dashboard `sessionId`.

A tab keeps its session across reloads, and a new tab, including a duplicated tab,
starts a new one. Mobile
starts a session at launch and another after 30 minutes in the background, never
while a call is open. Server-side SDK clients have no session.

The SDK sends `baggage: session.id=<uuid>` with a `traceparent` on every Chalk API
request, and the same `baggage` text in the Sync `hello` frame (browsers cannot set
upgrade headers). The API copies a valid lowercase UUID onto every span started
under the request and adds `session.id` to its structured logs. Sync adds it to
connection spans and logs. Any other value is ignored. The ID is request and
connection scoped: it is not written to the journey ledger, to Sync frames sent
back to the client, or to durable lifecycle rows.

```apl
| where ['session.id'] == "<session-id>"
```

Run it in the API log and Sync trace datasets to see everything one device did,
including requests before a join and across several joins.

Deploy the API and Sync before the SDK. The API must allow the `Baggage` header in
CORS. A Sync that predates the field rejects a `hello` with `baggage` (an error
frame, then close 1009), so the SDK retries once at once without it, remembers
that server for the rest of the page or app run, and sends the legacy `hello` on
later reconnects. The whiteboard client sends the same baggage member beside its
presenter-view extensions, then retries without baggage after a 1009 close from
an older server.

### Measure client readiness for the own SFU

`chalk.api.access_grant.issuance` has bounded tags `outcome`, `reason`, and
optional `chalk_sfu_declared` (boolean). The boolean comes from the parsed
`X-Chalk-Media-Providers` capability used by media binding resolution: `true`
when it declares `chalk_sfu`, and `false` when absent or containing only other
providers. No header text, SDK version, or client identity is exported as a tag.
Host-approved legacy guest admissions do not retain the guest's declaration.
Their server-assumed provider support is not a client declaration, so those
issuances omit `chalk_sfu_declared`. The guest's later credential collection or
refresh supplies its own declaration and emits the boolean as usual. Issuances
without declaration context also omit the tag. The issuance duration metric
keeps only `outcome` and `reason`.

To see how many credential issuances come from clients that do not declare
`chalk_sfu`, filter the issuance counter to `outcome=issued`. Divide the sum of
counter increases with `chalk_sfu_declared=false` by the sum across both boolean
values in the same time window. Exclude all series without the tag, including
host-approved legacy admissions and older series. This measures credential
issuances, including refreshes, not unique participants or all join attempts:
requests rejected before credential issuance do not increment this counter. No
sunset is planned, so no threshold on this share gates anything.

### Compare call quality by connection type

The SDK summarises WebRTC stats on the device every 10 seconds and uploads them
under the session ID: about every minute while a call is open and once at leave,
through `POST /v1/tenants/{tenant_id}/call-stats`. A call stops producing
summaries after 360 (about an hour), a batch holds at most 30, a failed upload is
dropped, and the API allows 30 uploads per participant per ten minutes. Each
summary becomes one `sdk.call_stats` API log line with the session ID, Space,
Episode, a hashed participant ID, and these fields: `connection_type` (`udp`,
`tcp`, `turn`, `unknown`), `rtt_ms`, `send_loss_pct`, `recv_loss_pct`,
`send_jitter_ms`, `recv_jitter_ms`, `send_bitrate_kbps`, `recv_bitrate_kbps`,
`send_layer` (`h`, `m`, `l`: the highest layer that sent during the window),
`recv_height`, `freeze_count`, `freeze_ms`, and `recv_paused_videos` (own SFU
only: remote videos the SFU paused for this device's network at the end of the
window, 0 to 64). Candidate types come from the
selected candidate pair. The body has no IP address, SDP, or free text. The API
adds `country` (the edge's country code), `client_family`, and `client_os` from
the request, so calls compare by region and platform without storing an address.
It also adds `provider` (`cloudflare_sfu` or `chalk_sfu`) and
`provider_session_id`, the media connection ID from the participant's media
credential. That ID is the session the own SFU names in its logs and in
`/inspect`, so one device's stats join the SFU's view of the same connection.

```apl
['<api-log-dataset>']
| where ['attributes.event'] == "sdk.call_stats"
| summarize
    samples = count(),
    rtt_p50 = percentile(todouble(['attributes.rtt_ms']), 50),
    rtt_p95 = percentile(todouble(['attributes.rtt_ms']), 95),
    loss_p50 = percentile(todouble(['attributes.recv_loss_pct']), 50),
    loss_p95 = percentile(todouble(['attributes.recv_loss_pct']), 95),
    freeze_rate = sumif(todouble(['attributes.freeze_count']), isnotnull(['attributes.freeze_count'])) / count()
  by ['attributes.connection_type']
```

Add `by ['attributes.country']` to compare regions. Field paths follow the
dataset's log mapping, so match them to how `sdk.connection_report` appears there.
Add `| where ['session.id'] == "<session-id>"` to read one device's call.

### Compare call quality by provider

The same `sdk.call_stats` lines carry `provider`, so one query compares the two
providers while Cloudflare SFU and the own SFU run side by side. It is a saved
query, not an alarm: nothing pages on it. Keep it as the Axiom saved query
`call-quality-by-provider` and read it after a cutover step or when a
provider-tagged connection report points at one provider. A sample window holds
about ten seconds, so compare `samples` before trusting a percentile.

```apl
['<api-log-dataset>']
| where ['attributes.event'] == "sdk.call_stats"
| extend provider = iff(tostring(['attributes.provider']) in ("cloudflare_sfu", "chalk_sfu"), tostring(['attributes.provider']), "unknown")
| summarize
    samples = count(),
    rtt_p50 = percentile(todouble(['attributes.rtt_ms']), 50),
    rtt_p95 = percentile(todouble(['attributes.rtt_ms']), 95),
    send_loss_p95 = percentile(todouble(['attributes.send_loss_pct']), 95),
    recv_loss_p95 = percentile(todouble(['attributes.recv_loss_pct']), 95),
    freeze_rate = sumif(todouble(['attributes.freeze_count']), isnotnull(['attributes.freeze_count'])) / count(),
    freeze_ms_p95 = percentile(todouble(['attributes.freeze_ms']), 95)
  by provider
```

Add `by provider, bin(_time, 1h)` for a trend, or `by provider, ['attributes.connection_type']`
to separate relayed calls from direct ones.

### Own-SFU video paused for network

On the own SFU (`chalk_sfu`), the SFU picks each viewer's simulcast layer under
the one the SDK requests, and pauses a remote video when the viewer's link cannot
carry even the lowest layer. Audio keeps flowing. The join sends the
`serverLayerAdaptation` and `subscriptionState` capabilities, and the SDK then
changes three things. Its own layer policy only caps the layer at the tile size,
so the SDK and the SFU do not run competing upswitch loops. A remote video that
has been quiet for 2 s makes the SDK read
`GET .../participants/{participant_id}/media/sfu/subscriptions`, which returns
each of the caller's subscriptions with `state`, `reason` (`congestion`,
`viewer`, `source_inactive`, `source_unauthorized`), `revision`,
`requested_rid`, and `effective_rid`.
The route reads only the credential's own connection, and a Cloudflare Episode
answers 400. While the SFU reports a pause, the stall check leaves that video
out, so the SDK does not repull it after the 7 s window, and the tile shows
"Video paused for network" until RTP returns or a read says the SFU resumed it.
A read that says the video is active, or a read that fails, gives the video back
to normal stall recovery. Off-screen video is paused in place with a
`tracks/update` that carries `paused` and no simulcast, and is resumed the same
way, so it needs no close, pull, or renegotiation. The Cloudflare adapter refuses
`paused`, and the Cloudflare path keeps its `h`-first pulls and receive-only
closes.

To follow one device, find its `provider_session_id` in `sdk.call_stats` and
match it to the session in the SFU's logs. A rising `recv_paused_videos` with low
`recv_bitrate_kbps` means the SFU is protecting audio on a slow link, not a
receive stall. A failed subscriptions read appears in connection reports as
`media_error_step` `sfu_subscriptions`.

A congestion pause is transient delivery that the client observes. It changes no
durable journey boundary: the Episode, the participant, and the publication stay
as they were. So it adds no journey-ledger event, and its evidence is the call
stats and the SFU's own state.

### Rejected CORS origins

A rejected `Origin` emits a `cors.origin_forbidden` API warning log with the
sanitized origin, policy and HTTP method, and adds `cors.outcome=forbidden`,
`cors.policy` and `cors.origin` to the `journey.phase.http` span. The origin keeps
only scheme and host: ports, paths, queries and credentials are dropped, IP
literals become `[ip]`, and anything else unparseable becomes `invalid`.

### Direct and Tunnel ingress

Every API request span (`journey.phase.http`) carries `ingress=direct` or
`ingress=tunnel`, as Sync's `sync.websocket.handshake` does. `direct` means the
host's TLS proxy marked the request with `X-Chalk-Ingress: direct`, and only a
trusted proxy peer (`CHALK_API_TRUSTED_PROXY_CIDRS`) can set the mark; everything
else is `tunnel`. A client can also send the mark through the Tunnel, because the Tunnel peer is trusted: that request is classified `direct` and only subjects itself to the direct bound, so treat the attribute as client-influenceable and read it with the proxy's own request counts. Split signalling latency and errors by it. A direct request
over the per-IP bound (300 in 10 seconds, before any credential check) answers
429 with `Retry-After` and counts as the `direct.ingress.ip` policy. The change
adds no journey-ledger event: no lifecycle transition changes, and a join under
either ingress keeps one trace.

### Interrupted recording stops and missing provider tracks

A capture completed from retained bundles without a confirmed stopped callback
adds `recording.capture.salvaged` to the durable journey ledger in the same
transaction as completion. It links to the recording's start journey and parent
event when available, with the trace and span IDs of the current database
completion span. Legacy rows without journey metadata use the recording ID
as the journey ID. Its attributes contain only the recording ID, capture epoch,
`reason=stop_unconfirmed`, and `source=committed_bundles`. Confirmed stops do not
emit this event, and replaying a completed lease cannot emit it twice.

Durable capture completion commits a pending capture-stopped publication obligation
with the completed media, capture lease release, reservation release and capacity
release. It immediately attempts the existing `recording_capture_stopped` outbox
operation. An outbox insert failure, including server-side query cancellation,
rolls back only that insert. The obligation retains its SQLSTATE and next attempt
time; the capture stays complete and rendering/transcription can proceed.

API pipeline maintenance seeds missing obligations from older durable completions
(the #614 safety net), then drains at most 100 due obligations per cycle with
`FOR UPDATE SKIP LOCKED`. Failed inserts use exponential backoff from five seconds
to five minutes. Publication has no absolute deadline and never reacquires capture
capacity or reopens media completion. Existing media-completion retry and source
retention limits remain unchanged. The previous publication-failure journal and
API error classification remain compatible with older API/worker images.
Legacy epoch-zero completions have no current recorder authority. Ordinary recovery
skips them; the `recording-stop` alert keeps them visible for explicit repair.

Immediate publication and the drainer use the original applied manual-stop
operation, capture epoch, journey and parent-event IDs. Immediate completion also
persists its trace/span carrier for later publication. Both paths share #614's
request key and skip an existing pending or applied callback. A changed stop or
epoch retires the obsolete obligation. A source stop still pending in Sync keeps
the obligation pending until that authority is applied. Sync retains its normal callback authority
checks, including an Episode end that adopts the stop (#618).

Capture close-track rejections inside HTTP 200 responses emit
`cloudflare_sfu.request_failed` in API logs before conversion to the worker's
failure code. `provider_raw_code` carries only a known Cloudflare code, an upper-case code of at
most 64 characters, or `other`. The provider's free-text description is never
logged, returned or exported, because it can echo a failed dial's host or address:
only `provider_message_fingerprint`, a hash of it, identifies the message, and the
response snapshot replaces each description with `redacted-<fingerprint>`. The
active API span receives the same values as `chalk.provider.raw_error_code` and
`chalk.provider.message_fingerprint` on `cloudflare_sfu.provider_failure`. No request bodies, SDP or credentials are
retained. Both capture track-close and connection-close use this path. Retry and
HTTP 200 acceptance rules are unchanged.

When the API cannot mint Cloudflare TURN credentials it logs
`cloudflare_turn.credentials_failed` at warning level with the failure cause and
no credential, and the join continues with STUN only. A sustained stream of this
event means clients behind strict networks cannot connect.

The own SFU does the same: it logs `chalk_sfu.turn_credentials_failed` with the
node and the Episode id, and the join continues with STUN only. Each failure also
adds one to the API metric `chalk.sfu.turn_mint_failures`, whose only attribute is
`chalk.media_plane.provider`; it carries no Episode id, so its cardinality stays
fixed. Search the log for the Episode id to find the affected class. Any value
above zero over a few minutes means clients on UDP-blocked networks cannot
connect media. The production monitor pages on three of either TURN event in five minutes
(`cloudflare_turn.credentials_failed`, and `chalk_sfu.turn_credentials_failed` once Cloudflare SFU
is retired).

A live own-SFU Episode whose node goes silent (no probe answer for the probe freshness window, so one missed probe does not count), or answers
with another `NodeIncarnation` than its binding recorded, moves through one
generation-fenced binding change (see the SFU milestones, M11). Each attempt adds one
to the API metric `chalk.sfu.episode_recoveries`, whose only attributes are
`chalk.sfu.recovery.reason` (`node_silent`, `node_restarted`) and
`chalk.sfu.recovery.outcome`: `moved`, `lost_race` (another API replica committed
the move first and this one followed it), `refused_no_node` (no node was fit to ask),
`refused_no_room` (every node asked answered and refused the reserve) and `refused_unreachable`
(at least one node asked could not be reached or failed, and none accepted). It carries no Episode id. The logs name the Episode: `chalk_sfu.recovered`
(from and to node, generation), `chalk_sfu.recovery_refused` (callers then get 503
`media.unavailable` and retry; the binding did not change) and `chalk_sfu.recovery` at warning
level for each node that could not reserve. A sustained `refused_*` rate means live calls cannot
leave a lost node: check pool capacity first. The production monitor pages when
`chalk_sfu.recovery_refused` is logged in three distinct minutes of five. Any `moved` is worth a look
at the lost node.

A moved or ended own-SFU Episode owes a retire to every node it left. The debt is a row in
`sfu_retirement_debts`, written in the same transaction as the binding move, or re-recorded when the
Episode ends. The Episode's end is confirmed once that row is durable, not when the node acknowledges
it. The API worker pays each debt every few seconds with a growing backoff (5 seconds up to 5 minutes)
and deletes it when the node acknowledges the retire, when the node answers with a new boot, or when the
node is no longer configured. A node that stays silent on the control path keeps three things apart.
The fence: the node's retirement floor, if it ever received one, expires after 24 hours, and that only
ends the refusal of lower generations; it never closes a session. The sessions: a session closes when
the retire is acknowledged, when the node restarts, or when its own peer connection fails or its client
closes it, so a node that stays silent for good keeps its connected sessions until it restarts, with no
time limit. The media: forwarding and publication stop within the source lease TTL
(`SFU_SOURCE_LEASE_TTL`, 15 seconds by default, at most 2 minutes), because the API stops renewing a
lease once the Episode moves or ends and the node checks the lease on every write. Three signals show unpaid debt:
the gauges `chalk.sfu.retirement_debts` (count) and `chalk.sfu.retirement_debt_oldest_age` (seconds,
unit `s`), each reported by every API replica from the same table; the `sfu_retirement_debts` object
(`count`, `oldest_age_seconds`) in the `/readyz` body, which never fails readiness; and the warning logs
`chalk_sfu.retire_pending` and `chalk_sfu.retire_debt_unsettled` (a try failed or a settle failed; both
carry `tenant_id` and `episode_id`, and the API log handler adds the trace and journey IDs when the move
that owed the debt ran inside a request, so a try by the worker has none),
`chalk_sfu.retire_debts_unread` and `chalk_sfu.retire_backlog_unread` (the table could not be read).
The production alert collector reads the table itself, so the age is the same for every replica, and
pages when the oldest unpaid debt is above 15 minutes in four of five minute samples (the
`sfu-retirement-debt` rule). A healthy fleet pays a debt within seconds, so an older debt means a node
has been silent through many backoff cycles: check that node, and restart it if it is up but not
answering control calls.

The own SFU counts each control call that ends in a provider failure, after the adapter's
retries, in the API metric `chalk.api.chalk_sfu.failures`. Its attributes are
`chalk.media_plane.provider`, `chalk.provider.operation` (the route without the session ID,
such as `episodes/retire` or `sessions/tracks`), `chalk.provider.failure_stage` (`transport`,
`http_status` or `decode`) and, by stage, `chalk.provider.transport_cause` or
`http.response.status_class`. It carries no node, Tenant, Episode or Participant identity.
A caller that cancels is not counted, and an answer such as a gone session or a refused
request is not a failure. The own SFU has no failure span: the call has no span of its own.

SFU transport failures retain only the bounded `transport_cause` log field and
`chalk.provider.transport_cause` span/metric attribute, for both providers: `timeout`, `caller_canceled`,
`connection_reset`, `connection_refused`, `dns`, `tls`, or `other`. Raw transport
error text is not retained. A canceled or expired caller context produces
`cloudflare_sfu.client_canceled`, does not increment the provider-failure counter
or mark the provider span as an error, and is recorded as HTTP 499 without an
API error body. The HTTP client's own timeout and network failures remain 503s;
the six-second request timeout is unchanged.

HTTP-stage SFU failures record the provider's top-level `errorCode` in
`provider_raw_code` and the `chalk.provider.raw_error_code` span-event field.
Only exact codes from [Cloudflare's error reference](https://developers.cloudflare.com/realtime/sfu/observability/error-codes/)
are retained, including `session_error` and `not_found`. Other codes become
`unlisted`; invalid JSON or a missing, empty, or non-string `errorCode` becomes
`unparsed_body`. These HTTP failures retain no response descriptions, message
fingerprints, or bodies. Actual HTTP status and existing normalized errors remain
available. Forced close only recovers from an HTTP 200 track-level
`provider_internal` failure when a complete inspection of the same session
returns top-level HTTP 410 with `errorCode: "session_error"`; empty snapshots,
404s, incomplete bodies, and other failures remain unresolved.

For capture add-tracks responses containing `not_found_track_error`, API logs
retain `provider_response_snapshot` on `cloudflare_sfu.request_failed`; the
provider-failure span event carries `chalk.provider.response_snapshot`. This is
a projection of the documented response, capped at 4096 bytes and 16 tracks.
It preserves omitted identity fields and track order, hashes identity values,
redacts SDP and unknown error codes, filters descriptions, and drops unknown
fields. `omittedTracks` reports omitted entries. Use it to build a sanitized
fixture after a new occurrence; a documentation-based fixture alone does not
prove the shape of an earlier production failure.

### Listeners missing active audio publications

The API samples active Cloudflare SFU Episodes every five seconds, independently
of client requests. Each other participant's enabled `microphone` or
`screen_audio` publication starts a listener/publication grace window when first
observed. After more than 15 seconds without a successful pull, it emits
`media.listener_publication_unpulled` once for that pair. `step` is
`no_pull_attempted` or `pull_failed`; `error_kind` is a bounded per-track provider
code, `request_failed`, or `missing_result`. Success requires an exact returned
remote track identity and receiving MID, not merely an HTTP 200. A later failure
does not downgrade `pull_succeeded` on the same listener connection. This proves
provider pull acceptance, not received audio packets or completed renegotiation.

Affected Episodes emit `media.listener_publication_summary` at most once a minute
with `no_pull_attempted_count`, `pull_failed_count`, `pull_succeeded_count`, and
`overdue_count`. Healthy Episodes remain silent. Paused publications do not age;
closed/replaced publications and departed listeners are removed. Listener
connection replacement resets pull progress. The one-shot marker survives pauses
and listener connection replacement for a retained pair. Episode end removes
state on the next sample; shutdown clears it too. These process-local diagnostics
reset on API restart and assume pulls for an Episode reach the same API process.

Pull observations do not read the database or write logs. They retain bounded,
hashed publication-identity results, including pulls completed before the first
sample. Results are keyed by listener generation and connection and expire after
two minutes. Results bind to the request's publication reference when available,
otherwise to an in-memory identity snapshot captured before the SFU provider call
and fed by committed publication writes.
The write hook performs no extra reads or logging and cannot fail the publication
write when diagnostic capacity is exhausted. The sampler also refreshes identity
snapshots; an older incarnation/sequence cannot overwrite a newer commit. These
snapshots retain at most 128 Episodes and 128 hashed identities per Episode and
expire after two minutes without a refresh. After a process restart, a pull
without a known identity remains bounded pending evidence until the first
sample; it is matched only if no publication write for that Episode intervened.
Reusing a publisher connection and track name therefore does not transfer
success to a replacement publication, even if it commits during an in-flight pull.
Episode reconciliation and event collection share one per-Episode lock; payloads
are emitted after unlocking, so a slow log sink does not hold up pull observations.

Events reuse Tenant, Space and Episode IDs, plus `participant_id_hash` and
`publication_id_hash` (lowercase hexadecimal SHA-256 of the listener's participant
ID and the complete publication reference, respectively). Publication references
can encode client-supplied track names and MIDs, so they are never logged raw or
reversibly encoded. No identity labels, raw error text, credentials, SDP or media
payloads are added. The existing
`cloudflare_sfu.add_tracks` log also includes up to 16 normalized
`track_error_kinds`, without remote track names or remote session IDs.

Retained state is capped at 128 Episodes, 128 participants and 128 publication
entries per Episode, and 1024 pairs per Episode. Publication references above
4096 bytes are ignored. Pending pull results are also capped at 1024 per Episode,
with at most 128 distinct remote tracks retained from each request.
A truncated Episode summary marks `truncated=true`;
Episode overflow or read failures emit the rate-limited
`media.listener_publication_sampling_incomplete` event. After two minutes without
a fresh sample, stale state is discarded rather than diagnosing from old data.
Caps and failed reads can leave coverage incomplete. Discovery and evaluation
are sampled, so a newly visible pair normally logs roughly 15–25 seconds later.

#### Alarm

The [listener audio check](../infrastructure/listener-audio-alert/README.md)
runs every five minutes against a ten-minute Axiom window. One
`media.listener_publication_unpulled` event (Cloudflare SFU only) pages Oncall. An
`sdk.connection_report` with `['attributes.trigger'] == 'audio_receive_stuck'` (both
providers, signal `client_audio_stuck:<provider>`) pages only when at least two
distinct participants (`attributes.participant_id_hash`) reported it on the Episode in
the window, the count `connection-reports.apl` uses; reports without a hash never
count. Each page is one incident per Episode with per-signal counts. The client
report is the provider-neutral signal: it stays when M13 removes Cloudflare and its
sampler. The stable `listener-audio:chalk:<episode_id>`
key lets Oncall dedupe overlapping windows and subsequent repeats. Public logs
contain only aggregate counts; the query projects only `episode_id`, `signal`, `events`
and the distinct `participants` count, and validated UUIDs go only in the Oncall POST body. The workflow requires
`CHALK_AXIOM_QUERY_TOKEN`, `CHALK_AXIOM_LOG_DATASET` and the existing
`ONCALL_WEBHOOK_URL`. `CHALK_AXIOM_LOG_DATASET` must be the production API log
dataset, the same one the production Axiom monitors use as `LOG_DATASET`.
The query does not filter by environment: pointing it at a dataset that also
holds nightly logs would page for nightly. A fired alert fails the run so GitHub
sends a failed-run email. Because `media.listener_publication_unpulled` is
one-shot per pair and `audio_receive_stuck` is sent once per unhealthy episode, a
stuck Episode stops firing roughly ten minutes after its last new event. A webhook-only drill never reads Axiom.
The `listener-audio` scope must also be registered for Chalk in Oncall's registry
outside this repo. GitHub scheduling can delay the roughly five-minute paging target.

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

### Own SFU congestion, repair and admission

The own SFU (`features/media/sfu`) logs structured JSON with no Tenant, Episode,
Participant, address, SDP, certificate or payload in its node-wide lines.

- `media telemetry`, every 10 seconds: sessions, Episodes, node packets/s and
  the repair and probe parts of it, subscriptions paused for congestion, subscriptions
  the Episode plan pauses to hold its ceiling (`plannerPaused`), cameras
  the Episode ceilings cap or pause, pacer queue delay p95, Go scheduler latency
  p99, CPU steal where the host reports it, and the admission reason.
- `new Episodes refused` (warn) and `new Episodes admitted again` (info) when
  the admission reason changes to or from `cpu_steal`, `cpu_busy`,
  `scheduler_latency`, `pacer_drops` or `udp_buffer_errors`, with the readings
  that decided it. Every refused join or screen share logs a `refused` warning
  with its reason. Live Episodes keep admitting
  their Participants while new ones are refused.
- `media readers still running after close` (error) when shutdown gave up
  waiting for a stream reader. A publisher that sent a second SSRC under a RID
  causes it; the process still exits.
- `subscription paused for congestion` and `subscription resumed after a congestion pause`
  (info) identify the subscriber by its media `connectionId` and subscription `mid`,
  with the allocated `rid`, `reason` (`insufficient_bandwidth` or `bandwidth_recovered`),
  `estimateBps`, `provenBps`, `deliveredShare`, `probing` and `hostPressure`, and the evidence behind the estimate:
  `ackedBps`, `lossShare` (the latest loss window), `lossy` (heavy loss reported in the last 2 s), `trend` (`normal`, `overuse` or `underuse`)
  and the latest estimate decrease (`decreaseCause` `overuse` or `loss`, empty before the first; `decreaseAgoMs`, `decreaseFromBps`, `decreaseToBps`, `decreaseAckedBps`).
  The connection ID and MID together correlate one subscription across transitions;
  no track names or participant identities are logged.

To follow one subscriber, call the session's `inspect`. Each subscription shows
its requested and effective RID, `state` and `reason` (`congestion` for a
network pause; the wire reason of a pause by the Episode plan is `congestion` too,
and only `plannerPaused` and the metrics tell the two apart), and its transport shows the estimate, proven rate, feedback age,
queued bytes, packets per class, pacer drops, repairs cut by the rate cap and
probes. The Episode block shows its packets/s against its ceiling. `/readyz`
shows the host signals behind admission, plus goroutines, in-use heap and resident memory for a soak sampler; `/debug/pprof/` (same service identity) gives heap and goroutine profiles, never exported as telemetry.

The node also exports metrics over OTLP/HTTP to the API's metrics dataset, as
`service.name=chalk-sfu` with `deployment.environment.name` and the node
incarnation as `service.instance.id`, so call quality and host health are
readable without SSH. They carry no Tenant, Episode, Participant, session or
address. Their only attributes are `chalk.sfu.direction` (`in`, `out`),
`chalk.sfu.media_kind` (`audio`, `video`, and `repair` and `probe` out),
`chalk.sfu.refusal_reason` and `chalk.sfu.admission_reason`.
The export matches `inspect` and carries no identities.

- Load: `chalk.sfu.sessions`, `chalk.sfu.episodes`, `chalk.sfu.packet_budget`,
  `chalk.sfu.packets.reserved`, and `chalk.sfu.packet_rate` and
  `chalk.sfu.bitrate` over the last second by direction and kind.
- Totals since start, as cumulative counters: `chalk.sfu.packets` and
  `chalk.sfu.bytes` by direction and kind (RTX sent is `out`/`repair`),
  `chalk.sfu.pacer.drops`, `chalk.sfu.repairs.cut`, `chalk.sfu.nack.requested`,
  `chalk.sfu.keyframe_repairs`, `chalk.sfu.rtx.received`,
  `chalk.sfu.layer.switches`, `chalk.sfu.udp.send_refused` and
  `chalk.sfu.udp.receive_truncated` (datagrams the media socket's kernel calls
  refused or cut short; both stay 0 when `SFU_UDP_BATCH` is off), and
  `chalk.sfu.refusals` by reason (`draining`,
  `sessions`, `fences`, `episode_full`, `mandatory_media`, `node_full`,
  `cpu_steal`, `cpu_busy`, `scheduler_latency`, `pacer_drops`,
  `udp_buffer_errors`, `screen_ceiling`, `cameras`, `capture_limit`, `holds`; a refused Episode reserve counts under its reason).
- Quality and host: `chalk.sfu.subscriptions.congestion_paused` (network pauses
  only), `chalk.sfu.subscriptions.planner_paused` (pauses to hold an Episode
  ceiling),
  `chalk.sfu.cameras.capped` and `.paused`, `chalk.sfu.pacer.queue_delay.p95`
  and `chalk.sfu.scheduler.latency.p99` in seconds, and
  `chalk.sfu.host.cpu.steal`, `chalk.sfu.host.cpu.utilization` (ratios over the
  guard window) and `chalk.sfu.host.udp.receive_buffer_errors` and `.send_buffer_errors`
  where the host reports them.
- State and process: `chalk.sfu.draining` and `chalk.sfu.admission.closed`
  (1 or 0, with the admission reason), `process.cpu.time` and
  `process.memory.usage` (resident bytes, Linux).

The API counts own-SFU placement decisions for new Episodes as
`chalk.api.media_plane.placement_decisions`, with `chalk.media_plane.provider`,
`chalk.media_plane.node_role` (`primary`, `standby`, `overflow`) and
`chalk.media_plane.placement_reason` (`primary`, `standby`, `overflow_no_room`,
`overflow_host_guard`, `overflow_draining`, `overflow_node_unavailable`, `overflow_node_protocol_too_old`, `no_capacity`).
`standby` means every primary was silent, draining, host-guard closed or out of budget. `overflow_no_room` means a node that takes new Episodes was out of
packet budget, `overflow_host_guard` means a node's host guard refused new Episodes
(CPU or scheduler pressure) whatever budget was left, `overflow_draining`
means every node that answered was draining (a planned state, not a capacity shortage),
`overflow_node_unavailable` means no node answered ready, and `overflow_node_protocol_too_old` means
the nodes that answered report an older SFU wire protocol than the API sends (the SFU was not deployed before the API; the
API logs `chalk sfu node is out of placement` with `reason=node_protocol_too_old`, the node's protocol and its build commit).
The binding of an Episode that overflowed for this reason reads `overflow_node_unavailable`.
A node with no probe answer, or one that answers an older protocol, is never placed on, so until an API process
finishes its first probe round (it finishes before the server takes requests) new Episodes count under
`overflow_node_unavailable`. One missed probe does not remove a node: its last answer stays usable for three probe
intervals. Without a Cloudflare application, or with overflow off, a new Episode that no node can take is refused
(`503 media.unavailable`, nothing bound) under the reason above, so no Episode is bound to a node that cannot take it.
The `no_capacity` reason stays readable on bindings an earlier release wrote. The counter counts decisions, not
committed Episodes: placement runs inside the creation transaction, so a request that
later rolls back (for example an Episode already live in the Space) still counts once.
Read it as a rate of placement attempts by outcome. The binding frozen on a committed
Episode is the record of what was kept. Every overflow decision also writes one API log line
at warn level with `event` `chalk_sfu.overflow`, the `provider` the Episode went to (`cf_sfu`
when it moved to Cloudflare, `chalk_sfu` when overflow is off and it was refused) and the
bounded `placement_reason`. The line carries no Tenant, Space, Episode or node identity, adds
no journey-ledger event, and like the counter it counts decisions, so a request whose creation
rolls back still logs once. Axiom monitors read this line, not the counter: the `sfu-overflow` branch of the first production
monitor alerts on any `chalk_sfu.overflow` line in the last two minutes (see the
[SFU runbook](../infrastructure/observability/production-alerts/sfu-runbook.md)). A refusal with
overflow off also counts toward the API 5xx alert.

`CHALK_SFU_CLOUDFLARE_OVERFLOW=false` turns Cloudflare overflow off: a new Episode that
no node can take is then refused with `503 media.unavailable`. It is counted under its
`overflow_*` reason on the `chalk_sfu` provider (the same reason on `cf_sfu` means the Episode
moved to Cloudflare), and `http.failure` logs the bounded reason
`no own sfu node with room (full, draining, host guard closed or not answering) and cloudflare overflow disabled`
without the `overflow_*` reason.
The same reason and the node's boot incarnation are frozen in the Episode binding
(`placement_reason`, `node_incarnation`), so a past overflow stays findable.

When `CHALK_SFU_CLIENT_SUNSET` is set, which no deployment plans, an Episode start
refused because the client cannot run the own SFU logs `chalk_sfu.client_refused`
with the bounded reason `client_sunset` and no Tenant or user data (see
[Client sunset](../infrastructure/sfu/README.md#client-sunset)).

A rate from the totals is exact over any window. A stream that closes between two
100 ms control ticks loses that tick's counts, so totals can run slightly under
the sum of every session's `inspect`. A restart starts every total again from
zero under a new `service.instance.id`.

The alert collector samples the node's `/readyz` and alerts when it stays
unreachable, draining, closed to new Episodes or above 90% of its packet budget;
see [Alerts](#alerts). `media readers still running after close` stays a journal
line and has no monitor, because it only happens while the process exits.
The paused-for-network journey (SDK `subscriptionState`) lands with the API and
SDK change, and adds its journey ledger entry then.

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

The deadline scheduler runs each Episode's deadline, presence-expiry and linger
work in its own savepoint, so one Episode that cannot take its publication
fences is skipped instead of rolling back the pass for every Tenant. Each skip
logs `episode.deadline_scheduler.failed` with `tenant_id`, `episode_id`, `phase`,
`reason` and `consecutive_failures`. The first grouped monitor alerts when one
Episode fails more than five passes in a row, or sixty for `control_busy`, which
normally clears within seconds when Sync settles the blocking operation.

The same collector independently samples Sync `/readyz` every minute, including
when its SQL snapshot fails. The grouped state monitor alerts when at least four
distinct minute samples in the last five minutes are unready and the latest
sample is unready and newer than 90 seconds. Duplicate samples in a minute count
once. This ignores a 24-second blip but catches the roughly five-minute readiness
outage observed on 28 October; Sync's internal one-second probes already apply
failure/recovery hysteresis, so paging on each probe would be too noisy.
The next healthy sample clears the condition on the next minute evaluation.
Messages include the latest allowlisted readiness reason, such as
`database_unavailable`, or an HTTP/transport fallback, without response bodies.
Missing samples do not establish continued unreadiness; the freshness monitor
expects this sixth rule and detects stopped collection within five minutes.
Collector/Discord tests cover safe reasons, database failure and recovery;
read-only synthetic Axiom query tests replay the blip and sustained window,
recovery, duplicate/missing samples and a change of reason.
An independent uptime Worker checks API/Sync health and readiness and reports
failures directly to Discord.
The collector also samples the own SFU's `/readyz` over mutual TLS when
`CHALK_ALERT_SFU_READY_URL` is set, and emits no SFU row otherwise. The same
grouped monitor alerts on four unhealthy minute samples in five minutes: a
draining or unreachable node, a node that refuses new Episodes (CPU steal, CPU busy, scheduler
latency, pacer drops or UDP buffer errors), or reserved packets at 90% of the packet budget. Only
allowlisted reason codes are exported, never TLS or HTTP error text, response
bodies or node identifiers. The freshness monitor does not count this row, so
hosts without an SFU stay quiet. See the production-alerts README for setup.

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

Readiness status transitions emit `sync.readiness.changed` through the same
observability path and JSON journal, only after hysteresis changes the cached
status. The event includes the prior and new status, allowlisted failure reason,
and consecutive failure count; recovery also reports time spent unready.

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

Sync connection spans, the three lifecycle events, and their stdout lines also
carry `session.id` when the client sent one in W3C `baggage` on the upgrade or
the `hello` frame. Search stdout for it to find every connection of one device
session. Sync never echoes it on frames or stores it with lifecycle records.

### Automatic browser connection reports

When the SDK replaces an SFU binding, its first track-signaling attempt includes
the optional `replacement_cause` query parameter. The API emits
`media.connection_replacement` with an allowlisted `replacement_cause`, using the
request's existing trace context. This records the origin of the new binding,
including when that first negotiation fails; it is not a successful-recovery
event. No extra request, identifier, device label, credential or browser text is
sent. Older APIs ignore the query parameter and older SDKs omit it. Unknown
values are ignored without rejecting signaling.

Receive-stall recovery uses `receive_stalled` only on the first signaling attempt
on a replacement binding. Only a stall of every expected-active inbound track can
replace a connection, through the existing recovery owner. Each publication
identity permits at most two receive-stall replacement attempts, including rejected
replacement grants. Seven seconds of sustained packet progress replenishes its
budget; a republish starts a new identity. Brief startup packets do not replenish
it. Flowing RTP uses a 7-second packet-progress window, separate from the new-pull
20-second startup grace. Hidden or throttled stats reset observation, not budgets. A Sync transport loss
or Sync-client stop clears eligibility while retaining identity budgets. A recovered authoritative
projection prunes withdrawn publications; Episode end or media stop clears them.
Opus DTX remains eligible because it still sends periodic silence packets.
Screen-share audio inherits its participant's screen availability while tracking
its own RTP counters and publication identity.

Partial stalls do not retry or replace. The SDK snapshot's optional `receiveStalls`
field is empty when absent and holds
the latest 32 `receive_stalled` observations, with scope (`partial` or `all`),
monotonic timestamp and expected/stalled track counts. These observations contain
no identifiers and send no additional request. Selective remote subscription
retirement needs an authorized API path and remains a follow-up.

Same-binding re-pulls (including per-publication failures) do not set
`replacement_cause`. Their existing `cloudflare_sfu.remote_track_response`
observation records bounded requested, missing and response track counts,
`partial`, SDP type and whether immediate renegotiation was required. It uses the
request's trace context without adding publication identifiers or browser text.
HTTP failures remain in the request's existing failure trace; a missing response
is not a connection-replacement event.

Retirement causes distinguish `user_pause`, `moderation_pause`,
`sync_recovery_loss`, `discovery_absent`, `capture_cleanup`, `consent_revoked`,
`publish_failure`, `enable_failure`, `projection_mismatch` and the legacy
`forced_pause` fallback.
Other replacement causes are `local_signaling_failure`,
`remote_signaling_failure`, `dormant_connection`, `receive_stalled`, `section_budget` (the connection
held too many closed media sections for the node's offer size limit) and `access_refresh` for an
externally refreshed binding. Capture interruptions detach microphone/camera
senders and retain their publication for short interruptions. Fresh user consent
within 20 seconds reattaches capture without replacing a healthy session. Longer
interruptions retire and republish, because the provider expires tracks after
30 seconds without RTP even while Chalk's registry retains the publication.
A second interruption during reattachment detaches again and returns
`local_source_paused` without closing the retained publication. The existing Sync
pause command is queued before the intentional sender detach and marks the owned
publication unavailable to other participants;
fresh consent restores availability. It is sent only for a matching owned
publication, including after delayed projection confirmation or Sync reconnect.
A delayed pause projection cannot rebuild while another expected track flows.
If every track detaches and Sync delivery is delayed, the same two-attempt bound
applies until availability arrives. User and moderation pauses still retire
their owned publication, including when the Sync command fails. A retired
BUNDLE sender still requires a fresh provider session.

Proof: the SDK covers interrupted capture, sender reuse,
retirement attribution and query-only compatibility. Its all-track cases assert
one replacement-cause signal per new binding and at most two attempts, including
rejected grants and brief startup traffic. Partial-stall and delayed-detach cases
assert zero replacements; screen-audio and packet/republish budget-reset cases
cover receive eligibility. Incomplete/partial/discovery backoff cases assert
same-binding retries carry no replacement cause. Late-close success/failure and
resumed-progress cases cover lifecycle races.
`sdks/typescript/client/scripts/real-sfu-receive-stall.mjs` verifies rendered audio
after an all-track fault, one live receive allocation per publication, and
replacement start and end-to-end times on a disposable SFU app. The API
decodes the query, records requested and missing remote-track observations, accepts
every allowed cause, and
suppresses unknown or identifying text. This is request-scoped diagnostic
evidence; it adds no durable journey event.

The TypeScript Connection SDK keeps the latest 64 connection events in memory
from construction, without installing a recorder. A failed join, terminal
connection failure, or exhausted recovery freezes one report and posts it to
`POST /v1/tenants/{tenant_id}/connection-reports`. Successful joins, normal leaves,
and successful recovery do not trigger failure reports; listener health summaries
can still upload during a healthy call. Sync socket opens/closes include codes
and timings; heartbeat gaps, join steps, media state/HTTP failures, and recovery
attempts use only known labels and bounded numbers. Cloudflare SFU uses HTTP
signaling and WebRTC, not a media WebSocket.

Local departure stops media and fires the React `onLeft` callback before durable
cleanup finishes. The `client.leave()` promise remains the confirmation boundary:
Sync stays connected for up to 40 seconds awaiting the durable acknowledgement,
followed by a bounded admission-cancellation fallback. Completion records
`cleanup_completed`; failure records `cleanup_unconfirmed`, rejects the promise
and emits `connection.leave_unconfirmed`. Unmount cleanup keeps the client alive
until that promise settles before disposal. Full-page navigation destroys the
client context, so its acknowledgement and error callbacks cannot be delivered;
already accepted durable server cleanup continues independently. This changes no
durable journey event.

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
in `sdks/typescript/client/src/connection/episode-end-race.test.ts`.

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
`peer_connection`, `access_refresh`, `sfu_tracks`, `sfu_close_tracks`, `sfu_renegotiate`,
`sfu_publications`, or `sfu_subscriptions`). SFU HTTP failures also carry `http_status` (400–599).
`network` identifies a fetch rejection or browser NetworkError, not an arbitrary
TypeError. `granted_audio` and `granted_video` are `granted`, `not_granted`, or
`unknown`: live tracks returned by acquisition, regardless of mute state, not
the requested intent. Fallback capture can grant only one kind. Before
acquisition completes these fields are `unknown`. Recovery retains the original
acquisition result, not a new permission query. Unclassified failures stay
`unknown`; no raw error text is serialized.
Deploy the API allowlist before shipping an SDK that emits these fields; older
APIs reject unknown report fields.

Two more events ride in the same buffer, so they appear only inside a failure
report and never trigger one. `receivers_closed` records each batch of up to 16
receive-only tracks the client closed, so a close of more than 16 receivers
yields several events and a failed later batch leaves the earlier ones reported:
`receivers_stopped` (0 to 10000) counts the receivers closed in that batch, and
`bundle_tag_held` is true when one of them owned the BUNDLE transport, which the
client parks inactive instead of stopping. `access_retry` records each time the
client asks for fresh access after a rejection: a join that retries after
Chalk rejected its access (whether or not the pending admission was cancelled
first), or a rejected media operation on an open connection. Its `state` field
is the connection state at that moment: `joining`, `live` or `reconnecting`.
Neither event carries a Space,
participant or media identifier. The report is tenant-scoped, and the API log
line already adds `space_id` and the `provider` of the verified media credential
(`cloudflare_sfu` or `chalk_sfu`), so the events add no plane field. The API
rejects the count and the flag on any other event. The replacement cause stays
on `media.connection_replacement`. Deploy the API allowlist to production before
the SDK release that emits these events.

A browser camera-effects processing failure records `media_state` with
`source=camera`, `phase=failed`, `outcome=failed`, `code=media_capture_failed`,
`media_error_kind=OperationError`, and `media_error_step=local_capture` before
the generated track ends. These are existing allowlisted labels. No error text,
device identifiers, image data, or camera frames enter the diagnostic buffer.

A failed chat file upload uses the same endpoint. The `chat_upload_failed` event
is also its own trigger (`upload_failed`, Warn-level, sharing the participant
failure cooldown). `upload_failure` names where the upload broke:
`initiate_failed` or `finalize_failed` (an API error; `http_status` carries the
status when the API answered), `storage_rejected` (the presigned storage URL
answered with `http_status`), or `storage_unreachable` (the browser got no HTTP
answer from storage: a network failure or a CORS block). A page with
`storage_unreachable` from a browser that otherwise works means the bucket CORS
rule is wrong. The report needs an open call connection, so a chat that runs
outside a call does not report.

Listener audio receive health uses the same report endpoint, not a second
diagnostic channel. It tracks desired remote `microphone` and `screen_audio`
publications, never camera or local capture. Two event names also serve as report
triggers:

- `audio_receive_stuck`: Warn-level `sdk.connection_report`, sharing the
  participant failure cooldown with join/recovery failures and projection
  mismatches.
- `audio_receive_summary`: Info-level `sdk.connection_report`, not alerting.
  The event buffer retains only the latest summary. Summaries have their own
  per-reporter spacing of at most one new report per five minutes; they neither
  use nor consume the participant failure cooldown. Summary uploads contain only
  `audio_receive_*` events. A failure replaces an unsent summary or queues after
  an in-flight summary, so a pending summary cannot suppress the failure.

The `receive_state` ladder records the furthest consecutive stage observed:

```text
announced → pull_requested → pull_failed / pull_succeeded → track_received → bytes_flowing → element_bound → playing
```

`pull_failed` is the failed branch of a pull, not a prerequisite for success.
Read the state with the companion fields, rather than treating an attached track
or a resolved `play()` promise alone as proof of audible audio:

| Furthest state   | Interpretation                                                                                                                                                                                                                      |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `announced`      | An audio publication is desired, but no pull has been requested.                                                                                                                                                                    |
| `pull_requested` | A pull was requested but has not reported success or failure.                                                                                                                                                                       |
| `pull_failed`    | Pull signaling failed; inspect the allowlisted `media_error_kind` and `media_error_step=sfu_tracks`.                                                                                                                                |
| `pull_succeeded` | Pull negotiation succeeded, but a live remote track has not been observed by the sampler.                                                                                                                                           |
| `track_received` | A live remote track exists, but matching inbound audio stats have not shown progress. With `track_state=muted`, no RTP is reaching the browser track; investigate the sender and receive path.                                      |
| `bytes_flowing`  | Inbound audio is progressing, but no observed audio element contains this track. Check that `AudioOutput` is mounted and binding the track.                                                                                         |
| `element_bound`  | Audio is progressing and an element is bound, but playback has not started or its `currentTime` has not advanced between samples. `play_result=NotAllowedError` identifies blocked autoplay; inspect the resume-audio gesture path. |
| `playing`        | Audio is progressing, the bound element's play promise resolved or its `playing` event fired, and its `currentTime` advanced between samples. This does not prove the output device is audible or its volume is nonzero.            |

Companion fields are bounded labels: `track_state` is `live`, `muted`, or `ended`;
`element_state` is `paused` or `playing`, reflecting the observed `paused` flag rather than confirmed playback; `play_result` is `ok`,
`NotAllowedError`, `AbortError`, or `unknown`. Rejected playback contributes only
that label, never raw error text. Summaries carry `receive_counts`, a fixed-key
object with optional counts from 0 to 10000 for each ladder state plus
`projection_off`. A disabled authoritative remote projection counts as
`projection_off` even when no track was pulled. Screen audio follows the screen
projection. Before authoritative projection state is available, the tracker
falls back to `track.enabled === false`. Disabled publications never trigger a stuck event;
re-enabling it restarts its stuck clock. Projection gating is not bypassed.

Sampling runs every five seconds, using one `getStats()` call on the receive peer
connection per sample regardless of audio track count, and no call when no audio
publications are tracked. This is the receive-health sampler's budget; other
media monitors can sample stats independently. The tracker produces a summary
every twelve samples (normally sixty seconds), while the reporter applies the
five-minute upload spacing. A non-playing publication becomes stuck only after
strictly more than ten seconds since announcement or the last healthy sample
(not at ten seconds). Each unhealthy episode reports once and re-arms only after
`playing`, with a lifetime cap of eight stuck events per media session. The
timer stops on media stop, including leave/dispose; results arriving after
disposal are ignored.

These observations change no user-visible lifecycle or durable journey boundary,
so they add no journey-ledger event. Diagnostic proof covers state/timing,
sampling disposal, pull failures, report spacing/priority/privacy, synchronous
element observation, playback rejection/cleanup, and API validation/log levels.
It does not constitute a real-browser audible-playback proof. The production
alert query in
`infrastructure/observability/production-alerts/connection-reports.apl` selects
only `join_failed`, `recovery_exhausted`, `media_projection_mismatch` and
`audio_receive_stuck` triggers; `audio_receive_summary` never matches it. The
alert message names the report's provider.

The API validates a maximum 32 KiB body and 64 events, rejects unknown fields and
labels, and authenticates the participant media credential against the route's
Tenant. It deliberately does not require an active participant or passing Sync
readiness: those can be the failure being reported. Identity comes exclusively
from that verified credential. The `sdk.connection_report` log (Info for
`audio_receive_summary`, Warn for other triggers) includes
`tenant_id`, `space_id`, `episode_id`, `provider` (`cloudflare_sfu` or `chalk_sfu`,
read from the verified media credential, so old SDKs report it too), SHA-256 `participant_id_hash` (the same
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
allows one failure report per participant per minute across connections in the
same module instance; summaries use their separate spacing described above.
The API enforces six reports per participant per ten minutes through its existing
limiter, including summaries. The SDK holds one pending report while offline, retries a
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

Explicit Leave confirms after the Postgres departure transaction, before provider
teardown. The existing `sync.external_operation.accepted` journey remains the
Leave acceptance boundary. The transaction writes `participant.left` to the
webhook outbox with its occurrence time taken from Leave acceptance, alongside
the committed receipt and a `remove_participant` cleanup operation identified by its departure operation ID.
Cleanup inherits the journey and trace context, so its provider span and retained
terminal failure can be inspected separately from the confirmed Leave. The
Postgres durable Leave proof blocks a fake cleanup provider and checks the
receipt, attendance timestamp, and webhook while that provider is still blocked.

## Hosted MCP operations

`/mcp` uses the API's HTTP trace context. Each application call adds a child span
named `mcp.<operationID>` with the tenant ID and the existing API operation ID.
The same application handler preserves the domain's durable journey events;
MCP does not introduce a parallel lifecycle ledger.

`mcp.tool.completed` records the curated tool, tenant ID, API-key actor ID, and
an allowlisted outcome code. `mcp.operation.completed` identifies the selected
application operation, including the action of a mixed-action tool. Look for
`mcp.protocol.rejected` for schema or protocol failures and `mcp.origin.rejected`
for Origin denial. Authentication failures retain the normal API HTTP signal.
These events contain no tool arguments, result bodies, bearer tokens, signed
URLs, transcript text, or signing secrets. Unexpected application errors return
only the existing public API error code and message.

OAuth sign-in for `/mcp` logs `mcp.oauth.*` events with grant, tenant and client
IDs only: `client_registered`, `grant_created`, `grant_revoked`, `reuse_detected`
(a replayed code or refresh token) and the `*_failed` events for server errors. They never carry tokens, codes, authorization request
handles, PKCE values or redirect query strings. `TestMCPOAuthKeepsSecretsOutOfLogs`
proves it. A rise in `reuse_detected` means a client is racing refreshes or
a token leaked. The grant lifecycle (approve, use, revoke) is visible in the
connected apps list; there is no separate journey ledger entry.

The Postgres proof `TestMCPPostgresToolsAndPermissions` drives the official Go
MCP client through Streamable HTTP. The MCP module's transport proof covers
Origin rejection, bounded UTF-8 continuation, body limits, and disabled SSE.

## Auto transcription provider

Auto MAI requests retain the existing dispatcher/API transcript lifecycle and
journey carrier. `dispatcher_completed` identifies `provider=openrouter`, fallback
use and attempts. Provider HTTP/timeout failures keep the existing bounded
`provider_*` retry reasons; malformed timing or Urdu conversion emits
`provider_schema_invalid` with field/type metadata, never transcript text,
provider bodies or audio. Silent Auto chunks complete with zero cues and zero
provider cost, not a provider failure. Fixed-language requests remain Whisper.
Provider word and segment timestamps are restored to the original source clock
before manifest-based speaker attribution. The dispatcher tests exercise this
mapping through a real synthetic FLAC decoder and a fake provider boundary.
