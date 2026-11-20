# Slice 12: Webhooks and tenant integration

This slice proves two things about a Tenant's integration with Chalk. First, every lifecycle change a subscribed webhook endpoint should hear about was committed as a webhook event, attempted on time, and answered 2xx by the Tenant's receiver, or the slice names where it stopped. Second, the Tenant's backend could authenticate and create the Spaces, Episodes, admissions and initial access grants its Participants need. SWE-2 builds it. It owns the prefixes `webhook.` and `integration.`. It depends on C1 (envelope, `ten_`/`spc_`/`ep_`/`pt_`/`whd_` handles, registry), C2 (`ProofBundle`, three-state values, verdict fields), C3 (`evidence_gap`, source watermarks) and C4 (compact CLI grammar). It consumes slice 14's API release markers and `release.started` boot facts, the `request_logs` field of its `flags.snapshot` and its edge rollups. Slice 8 owns how an Episode ends and slices 10 and 11 own recording and transcript lifecycles, so this slice only checks that their committed transitions produced webhook events. Slice 7 cites `integration.credential_refused` as a cause. Code facts are at `b3dc1d3afa`.

## 1. Scope

**Files owned.** Kernel calls and fields go only into these files:
- `apps/api/internal/webhooks/dispatcher.go` and `apps/api/internal/adapters/postgres/webhook_producer.go`, `apps/api/internal/adapters/postgres/webhook_dispatcher.go`, `apps/api/internal/adapters/postgres/webhooks.go`. Read `apps/api/internal/webhooks/delivery_client.go` and `apps/api/internal/webhooks/telemetry.go` for codes; don't edit them.
- `apps/api/internal/apikeys/service.go`, `apps/api/internal/httpapi/middleware.go`, `apps/api/internal/observability/http.go`.
- `apps/api/internal/authorization/tenant.go`, `apps/api/internal/httpapi/rate_limit.go`, `apps/api/internal/httpapi/access_grants.go`.
- `apps/api/internal/adapters/postgres/tenant_limits.go`, `apps/api/internal/adapters/postgres/episode_lifecycle_create.go`.
- New: `scripts/diagnose-call/webhooks.mjs (new)` and `scripts/diagnose-call/integration.mjs (new)` (rules); new exports `webhookSql(episodeId)` and `tenantSql(tenantId, from, to)` in `scripts/diagnose-call/database.mjs` next to `episodeSql` (`scripts/diagnose-call/database.mjs:35`); the files the rules read added to `DIAGNOSE_CALL_INPUTS` (`scripts/diagnose-call/inputs.mjs:6`).
- No Sync file. Decided: Sync emits no fanout decision in this slice, because its producer runs inside many callers' transactions and the `db` rows already prove both a missing event and an empty target set.

**Journeys.** (1) A lifecycle commit in the API or Sync, through fanout, claim, send and the terminal delivery state. (2) A Tenant backend calling `createSpace` (`apps/api/internal/httpapi/spaces.go:148`), `createEpisode` (`apps/api/internal/httpapi/episode_lifecycle.go:251`), `admitEpisodeParticipant` (`apps/api/internal/httpapi/episode_lifecycle.go:308`) and initial `issueAccessGrant` (`apps/api/internal/httpapi/access_grants.go:89`) with an API key.

**Neighbour boundaries.** An `issueAccessGrant` is initial when `current_media_token` is empty, `replace_media_connection` is true and `expected_media_connection_id` is absent (`apps/api/internal/httpapi/access_grants.go:117-119`); every other call is a renewal and belongs to slice 7. A 401 or 403 on a request that presented an API key is `integration.credential_refused` on any route; slice 7 cites it and never redefines it. The embed in the host page is slice 1. The webhook journey stops at the receiver's HTTP response: Chalk can prove its request got a 2xx back and can never know whether the Tenant then processed the event.

## 2. Symptom catalogue

| Code | Meaning | Who is affected | Severity |
|---|---|---|---|
| `webhook.event_missing` | A committed Episode or Participant transition that should have a `webhook_events` row has none. | Tenant backend, and Participants whose product state follows the event | medium |
| `webhook.delivery_stalled` | An eligible delivery waited more than 120 s for an attempt. | Tenant backend | medium |
| `webhook.not_delivered` | A delivery ended `exhausted`: no 2xx within 11 attempts or 72 h, or a non-retryable failure. | Tenant backend | medium |
| `webhook.outcome_unrecorded` | The receiver answered 2xx but the dispatcher lost its lease before recording it, so the event is sent again. | Tenant backend (duplicate) | low |
| `integration.credential_refused` | API-key requests got 401, 403 or an authentication 503, and the Tenant had no API-key success within 5 min. | Every Participant of the Tenant | high |
| `integration.episode_create_refused` | `createSpace` or `createEpisode` was refused or failed and no Space or Episode followed within 60 s. | Participants of that Space | high |
| `integration.grant_not_issued` | `admitEpisodeParticipant` or initial `issueAccessGrant` was refused or failed and was not retried successfully within 120 s. | The Participant being admitted | high |

## 3. Witnesses per symptom

A row and the ledger row (`observability_journey_events`) written in the same transaction are one witness. A log line and a kernel event emitted by the same function from the same value are one witness. A DB column written by the same handler that emits a decision is the same witness as that decision.

**`webhook.event_missing`.** `db` lifecycle columns `episodes.started_at`, `created_at`, `ended_at` (exists: `apps/api/db/schema.sql:435-442`) and `participants.joined_at`, `left_at` (exists: `apps/api/db/schema.sql:549-550`); only Sync writes the participant and end columns (`apps/sync/lib/chalk_sync/stateholder/postgres/sql/lifecycle.ex:177`, `apps/sync/lib/chalk_sync/stateholder/postgres/sql/lifecycle.ex:207`). `db` endpoint state (exists: `apps/api/db/schema.sql:3163-3176`) and revision `event_types` (exists: `apps/api/db/schema.sql:3213`). `db` `webhook_events` by `event_name`, `resource_type`, `resource_id`, `occurred_at` (exists: `apps/api/db/schema.sql:3264-3271`); `resource_id` is the Episode ID (`apps/api/internal/adapters/postgres/episode_lifecycle_create.go:119`) or the Participant ID (`apps/sync/lib/chalk_sync/webhooks/producer.ex:124`, `apps/sync/lib/chalk_sync/webhooks/producer.ex:246-249`). These `db` sources are independent: lifecycle code writes the transition, endpoint routes write the endpoint, and the producer writes the event. `api` fanout decision (missing: slice adds in `apps/api/internal/adapters/postgres/webhook_producer.go`) is the producer's own view; it adds the hop and the `duplicate` fact and is never required. The ledger `webhook.event.committed` (`apps/api/internal/adapters/postgres/webhook_producer.go:75`) is the same witness as the event row. Today two API paths write nothing at all: no targets (`apps/api/internal/adapters/postgres/webhook_producer.go:48-49`) and an insert that hits `on conflict do nothing` (`apps/api/internal/adapters/postgres/webhook_producer.go:66-67`, `apps/api/db/queries/webhooks.sql:122`). Sync's equivalents are an empty revision set (`apps/sync/lib/chalk_sync/webhooks/producer.ex:93`) and the conflict branch (`apps/sync/lib/chalk_sync/webhooks/producer.ex:166-167`). Sync always writes an `episode.ended` row, even with no receivers (`apps/sync/lib/chalk_sync/webhooks/producer.ex:91`).

**`webhook.delivery_stalled`.** `db` `webhook_deliveries` `state`, `next_attempt_at`, `attempt_count`, `lease_expires_at` (exists: `apps/api/db/schema.sql:3335-3340`); `db` attempt `started_at`, `finished_at` (exists: `apps/api/db/schema.sql:3406-3407`); `db` ledger `webhook.delivery.retry_scheduled` with a new `next_attempt_at` attribute (missing: slice adds in `apps/api/internal/adapters/postgres/webhook_dispatcher.go`), because the delivery row's `next_attempt_at` is overwritten at each claim. `api` fact `webhook.dispatch.cycle_failed` (missing: slice adds in `apps/api/internal/webhooks/dispatcher.go`). The dispatcher is a goroutine in the API process (`apps/api/cmd/main.go:730-732`); its exit stops the API (`apps/api/cmd/main.go:813-815`), so a dead dispatcher shows as a new slice 14 `release.started` boot fact for the API (with `previous_boot_end`) or as failing `edge.uptime_check` rows, never as its own log. The metric `chalk.webhook.delivery.oldest_eligible_age` (`apps/api/internal/webhooks/telemetry.go:31`) carries no Tenant ID (`apps/api/internal/webhooks/telemetry.go:13-15`), and the checker doesn't read it.

**`webhook.not_delivered`.** `db` delivery `state=exhausted` (exists: `apps/api/db/schema.sql:3335`) and the last attempt's `error_code`, `http_status` (exists: `apps/api/db/schema.sql:3410-3411`). That is the only witness. The ledger `webhook.delivery.exhausted` (`apps/api/internal/adapters/postgres/webhook_dispatcher.go:234`) and the log at `apps/api/internal/webhooks/dispatcher.go:247` copy it. A child delivery with `parent_delivery_id` (`apps/api/db/schema.sql:3344`) is a redelivery. The receiver can't report to Chalk: a 2xx in `http_status` is the only proof of arrival, and a 4xx can't tell a bad signature from any other refusal.

**`webhook.outcome_unrecorded`.** `db` attempt `outcome=lease_expired`, written by `RecoverExpired` in a later cycle (exists: `apps/api/internal/adapters/postgres/webhook_dispatcher.go:76`). `api` log "webhook delivery completion failed" (exists: `apps/api/internal/webhooks/dispatcher.go:241`; slice adds `http_status_class`). These are independent: the log comes from the sending dispatcher's `Complete` failure, and the row comes from whichever dispatcher recovered the lease. The new `op` terminal `webhook.delivery.attempt` is the same witness as the log.

**`integration.credential_refused`.** Refusal: `api` `http.request` with `status`, `route`, `error_code` (exists: `apps/api/internal/observability/http.go:165-180`; slice adds `auth_scheme`, `api_key_id`) and `api` decisions `api_key.authenticate` (missing: slice adds in `apps/api/internal/apikeys/service.go`) and `tenant.authorize` (missing: slice adds in `apps/api/internal/authorization/tenant.go`). The request line and the decision for one request are one witness. With `CHALK_API_REQUEST_LOGS=off` (the default, `apps/api/internal/config/config.go:156`) no request line is written at all (`apps/api/internal/observability/http.go:229-230`), so the decision is then the only refusal witness. Success: `api_key.authenticate accepted` and `api_keys.last_used_at` (exists: `apps/api/db/schema.sql:137`, written on every success by `apps/api/internal/apikeys/service.go:243`) are one witness; a 2xx `http.request` with `auth_scheme=api_key` is a second one. `db` `api_keys.revoked_at`, `expires_at` (exists: `apps/api/db/schema.sql:138-139`) are independent, because the revoke route writes them. Requests that never reached the API are seen only in slice 14's edge rollups, which count them by host and status but can't name the API key; when they show nothing either, that is unknown, not a finding.

**`integration.episode_create_refused`.** `api` `http.request` (exists: `apps/api/internal/observability/http.go:165-180`). `api` decision `episode.create.live_limit` (missing: slice adds in `apps/api/internal/httpapi/tenant_limits.go`). `db` `spaces`, `episodes` and `participants` rows (exists: `apps/api/db/schema.sql:428`, `apps/api/db/schema.sql:534`), counted by the checker itself and so independent of the decision's `live_count`.

**`integration.grant_not_issued`.** `api` `http.request` and `access_grant.rejected` (exists: `apps/api/internal/observability/http.go:264-269`; slice adds `grant_kind`): one witness, written by one request. `api` decisions `ratelimit.check` (missing: slice adds in `apps/api/internal/httpapi/rate_limit.go`) and `episode.admission.capacity` (missing: slice adds in `apps/api/internal/adapters/postgres/episode_lifecycle_create.go`), also the same request. `db` `participants` and `episodes.ended_at` (exists: `apps/api/db/schema.sql:534`, `apps/api/db/schema.sql:436`) are independent.

## 4. Rule conditions

Missing data never yields healthy. Each rule returns `broken`, `degraded`, `expected` or a gap; healthy comes only from the sealed `ProofBundle`. `asof` is the checker's read time. Attempt, delivery and event rows are deleted 30 days after the event's `occurred_at` (`apps/api/db/queries/webhooks.sql:229`, `apps/api/db/queries/webhooks.sql:237`, `apps/api/db/queries/webhooks.sql:245`), so anything older is `unavailable(retention_30d)` with coverage `partial(db)` and `gap: db unavailable(retention_30d)`. A rule whose window is still open at `asof` returns a gap on the source it still waits for, such as `partial(db)` with `gap: db window_open`, never a pass.

**`webhook.event_missing`.** Population: transitions at time T with `asof - 30d < T < asof - 30s`: `episode.started` at `coalesce(started_at, created_at)` (as `apps/api/internal/adapters/postgres/episode_lifecycle_create.go:113-116` does), `episode.ended` at `ended_at`, `participant.joined` at `joined_at`, `participant.left` at `left_at`. A row matches when `event_name`, `resource_id` and `date_trunc('milliseconds', occurred_at)` equal the transition's. `endpoint.test` is never in the population. Deleted endpoints are kept 30 days after `deleted_at` (`apps/api/db/queries/webhooks.sql:266-271`), so every endpoint that existed in the window is still readable.
- BROKEN for `episode.ended` whenever no row matches, whatever the endpoints, because Sync writes that row unconditionally (`apps/sync/lib/chalk_sync/webhooks/producer.ex:91`).
- BROKEN for the other three when no row matches and an endpoint of the Tenant had `created_at <= T`, `updated_at <= T`, `enabled=true`, `deleted_at` null, and a current revision with `api_version=1` whose `event_types` contain the event name. Module `api.webhooks.producer` and hop `api_fanout` for `episode.started`; module `sync.webhooks.producer` and hop `sync_fanout` for the rest. When the API fanout decision for that resource says `duplicate`, print it as a fact.
- EXPECTED when the Tenant has endpoint rows, every one of them has `updated_at <= T` or `created_at > T`, and each with `created_at <= T` was disabled, deleted at or before T, or not subscribed to the event at T. A Tenant with no endpoint rows is EXPECTED too, because any endpoint that existed at T is still readable.
- Gap when any endpoint has `created_at <= T < updated_at`, because its state at T is unknown: `partial(db.endpoint_history)`.

**`webhook.delivery_stalled`.** Stall start S is the delivery's scheduled time: `webhook_events.occurred_at` for attempt 1 (`apps/api/internal/adapters/postgres/webhook_producer.go:87`), else the `next_attempt_at` attribute of the latest `retry_scheduled` ledger row, else the row's `next_attempt_at`. When slice 14 shows the API down during the wait, S moves to the API's next start marker.
- BROKEN when a delivery is `pending` or `retry_wait` with `S < asof - 120s` and `attempt_count < 11`, or `delivering` with `lease_expires_at < asof - 60s` (`RecoverExpired` runs every 1 s cycle, `apps/api/internal/webhooks/dispatcher.go:101-108`). Module `api.webhooks.dispatcher`. Hop `dispatcher_loop` when a `webhook.dispatch.cycle_failed` fact falls in `[S, asof]` or the delivery is `delivering` past its lease; otherwise hop `dispatcher_claim`.
- DEGRADED when the first attempt with `started_at >= S` started more than 120 s after S.
- EXPECTED when, at every instant of the wait, the delivery's endpoint had 4 attempts in flight (`apps/api/db/queries/webhooks.sql:176`) or its Tenant had 20 (`apps/api/db/queries/webhooks.sql:193`), counted from attempt `[started_at, finished_at]` intervals, and every one of those attempts has `latency_milliseconds >= 5000` or `error_code=timeout`. Module `tenant.receiver`.
- Gap: when slice 14's markers are missing for the window, the BROKEN or DEGRADED finding still stands with S unmoved, and coverage is `partial(release)`. When the `api` log source is missing for the window, the hop stays `dispatcher_claim` and coverage is `partial(api.dispatcher_log)`.

**`webhook.not_delivered`.** Population: deliveries with `state=exhausted`. The last attempt's `error_code` maps to a cause. Retryable statuses are 408, 425, 429 and 5xx (`apps/api/internal/webhooks/delivery_client.go:133`); the 72 h horizon is at `apps/api/internal/webhooks/dispatcher.go:278`.
- BROKEN with `http_4xx` or `http_3xx`: cause `receiver_rejected`, module `tenant.receiver`, hypothesis "receiver refused the signed request (stale secret after rotation, or clock skew over 300 s)", falsified by a 2xx attempt on the same endpoint within 10 min after it with no `webhook.endpoint.secret_rotated` fact in between.
- BROKEN with `http_5xx`, `timeout`, `connect_failed`, `dns_failed`, `network_failed`, `tls_failed`, `response_too_large`, `response_headers_too_large`: cause `receiver_unreachable`, module `tenant.receiver`.
- BROKEN with `ssrf_blocked` or `unsafe_url`: cause `destination_refused`, module `tenant.endpoint_config`.
- BROKEN with `encryption_failed`, `request_invalid`, `invalid_http_status`, `lease_expired`, `retention_expired` (`apps/api/internal/adapters/postgres/webhook_dispatcher.go:325`), any other code, or no attempt row: module `api.webhooks.dispatcher`.
- DEGRADED instead of broken when a child delivery with this `parent_delivery_id` reached `succeeded`.
- EXPECTED: none. `canceled` and `erased` deliveries are the Tenant's choice and are outside the population.

**`webhook.outcome_unrecorded`.** Population: attempts with `outcome=lease_expired`, except `error_code=secret_rotated` (`apps/api/internal/adapters/postgres/webhook_rotation.go:42`).
- DEGRADED when the completion-failed log or the `op` terminal for the same `attempt_id` carries `http_status_class=2xx`. Module `api.webhooks.dispatcher`, hop `dispatcher_complete`. With another class the receiver didn't accept the event, so a redelivery isn't a duplicate and there is no finding.
- EXPECTED when there is no completion-failed log for the attempt and a slice 14 release marker (a deploy, not a crash restart) falls inside `[started_at, finished_at]`.
- Gap when the `db` row exists with neither a log nor a release marker: `partial(api.dispatcher_log)`.

**`integration.credential_refused`.** Group refusals by `api_key_id`, or by the path's `tenant_id` when no key row was found. The Tenant comes from the key row when found. A path-only Tenant counts only when that Tenant had an API-key success in the 24 h before the first refusal; otherwise the refusals go in a gap `partial(api.key_tenant)`. Only requests that presented an API key count, so a Dashboard Account's 403 never does.
- BROKEN when no API-key success for the Tenant (any key) falls within 5 min after the first refusal. Success is a 2xx `http.request` with `auth_scheme=api_key`, an `api_key.authenticate accepted` decision, or any Tenant key's `last_used_at` inside that window.
- DEGRADED when the refused key had no success but another key of the Tenant did.
- Module `tenant.backend` for reasons `malformed`, `unknown_prefix`, `hash_mismatch`, `revoked`, `expired`, `tenant_mismatch`, `scope_missing`; module `api.apikeys` for `lookup_failed` and `scopes_invalid`. Hypothesis for `unknown_prefix` when `rotateAPIKey` (`apps/api/internal/httpapi/api_keys.go:174`) ran for the Tenant in the prior 24 h: "backend still sends the pre-rotation key", falsified when the first refusal came before that rotation.
- EXPECTED: none.
- Gap `partial(api.auth_decision)` when the `api_key.authenticate` decision is missing for the window and the request log mode is `off`. Gap `partial(api.request_log)` when the decision is missing, the mode isn't `all`, and the only `last_used_at` is after the window, so a success inside it is unknown.

**`integration.episode_create_refused`.** No finding when the Tenant created a Space (for `createSpace`) or an Episode in the same Space (for `createEpisode`) within 60 s after the refusal. Codes 401 and 403 belong to `integration.credential_refused` and are skipped here.
- EXPECTED when the code is `tenant.live_episode_limit_reached` (`apps/api/internal/tenantlimits/limits.go:28`), the checker's count of the Tenant's Episodes with `created_at <= T` and `ended_at` null or after T is at or over the decision's `limit`, and every counted Episode had a Participant with `joined_at <= T` and `left_at` null or after T, or was created within 10 min before T.
- BROKEN otherwise for that code, cause `leaked_live_episode`: module `api.episodes` when a counted Episode had `deadline_at < T`, because the deadline scheduler should have ended it, else module `tenant.backend`.
- BROKEN for a 5xx: module `api.spaces` or `api.episodes` by route; cause `committed_but_failed` when `db` shows the Space or Episode created within 5 s of the request.
- BROKEN for `request.invalid` with module `tenant.backend`; for any other 4xx code with module `api.episodes` and hypothesis "unmapped refusal code".
- Gap when the code is `tenant.live_episode_limit_reached` and the decision is missing: `partial(api.live_limit_decision)`.

**`integration.grant_not_issued`.** Calls with `grant_kind=renewal`, and 401 or 403 codes, are outside the population. For admissions, one finding per (`api_key_id`, Episode) with the refusal count. A retry is a 2xx on the same route by the same key that starts after the refusal's `Retry-After` and within 120 s of the refusal: for `issueAccessGrant`, the same `participant_id` in the path; for admissions, `db` Participants created in the Episode in that window, which must number at least the refusals.
- EXPECTED for `episode.capacity_exceeded` when the checker counts at least 500 Participants (`apps/api/internal/episodes/service.go:75`) with `joined_at <= T` and `left_at` null or after T. Fewer is BROKEN, module `api.episodes`, cause `capacity_without_participants`, because Participants stuck in `joining` or the lifecycle budget (`apps/api/db/queries/sync_lifecycle.sql:249-262`) refused the seat.
- EXPECTED for `episode.not_active` when `episodes.ended_at < T`. Slice 8 judges whether that end was right.
- BROKEN for 429 with no retry: module `tenant.backend` when the key made at least 60 write requests (POST, PATCH, PUT, DELETE) in the 60 s before the first 429 (`apps/api/internal/httpapi/rate_limit.go:42-45`), else module `api.ratelimit`.
- BROKEN for 503 with `ratelimit.check` reason `limiter_unavailable` (`apps/api/internal/httpapi/rate_limit.go:260-265`), module `api.ratelimit`. Any other 4xx or 5xx is BROKEN with module `api.accessgrants` or `api.episodes` by route.
- Gap for a 429 when the request log mode isn't `all`, so the writes can't be counted: `partial(api.request_log)`, with module `tenant.backend` as a hypothesis. Gap for an `issueAccessGrant` failure with no `grant_kind`: `partial(api.grant_kind)`.

## 5. Boundaries to adopt the kernel at

| Kernel call | Name | File:line | Note |
|---|---|---|---|
| `decision` | `webhook.event.fanout` | `apps/api/internal/adapters/postgres/webhook_producer.go:30` | Emit inside `Record`, which every caller runs after commit (for example `apps/api/internal/adapters/postgres/episode_lifecycle_create.go:134`). Add `Outcome`, `ResourceType`, `ResourceID` to `webhookCommitMetric` (line 25) and set them on the returns at 49 (`no_targets`, only when `err` is nil), 67 (`duplicate`) and 95 (`committed`, `target_count`). |
| `op` | `webhook.delivery.attempt` | `apps/api/internal/webhooks/dispatcher.go:181` | Reuse the span at 188. One terminal: `ok` on 2xx and `error(<error_code>)` otherwise in `completeAttempt` (239-253); `error(lease_lost)` when `Complete` returns `ErrDeliveryLeaseLost`, else `error(complete_failed)`; `error(attempt_trace_failed)` at 198-201. Inputs `delivery_id`, `attempt_id`, `attempt_number`, `http_status_class`. |
| field | `http_status_class` | `apps/api/internal/webhooks/dispatcher.go:241` | Add `statusClassMetric(result.HTTPStatus)` to the completion-failed log. |
| `fact` | `webhook.dispatch.cycle_failed` | `apps/api/internal/webhooks/dispatcher.go:102-103` | `{stage, error_class}`; wrap errors in `runBatch` so `stage` is `recover_expired` (151-154), `claim` (156-159) or `deliver` (178). |
| ledger attribute | `next_attempt_at` | `apps/api/internal/adapters/postgres/webhook_dispatcher.go:240`, `apps/api/internal/adapters/postgres/webhook_dispatcher.go:86` | RFC 3339 UTC, on `webhook.delivery.retry_scheduled` rows only. |
| `fact` | `webhook.endpoint.secret_rotated` | `apps/api/internal/adapters/postgres/webhooks.go:338` | `{endpoint_id, immediate, previous_secret_expires_at}`, emitted after commit. |
| `decision` | `api_key.authenticate` | `apps/api/internal/apikeys/service.go:218-252` | `accepted` or `rejected`; reasons `malformed` (224), `unknown_prefix` (229), `lookup_failed` (232), `hash_mismatch`, `revoked`, `expired` (all at 234 today, split them there), `scopes_invalid` (238-239). Inputs `api_key_id` only. |
| fields | `auth_scheme`, `api_key_id` | `apps/api/internal/observability/http.go:165-180` | Add `recordPrincipal` to `failureRecorder` (81-84) and `responseRecorder` (126-127) with an exported `RecordPrincipal(w, ...)` beside `RecordErrorCode` (89), called in `apps/api/internal/httpapi/middleware.go:49-66`. The request context can't carry it outward. |
| `decision` | `tenant.authorize` | `apps/api/internal/authorization/tenant.go:81-93` | Refusals only: `tenant_mismatch` (85-86), `scope_missing` (88-89); inputs `required_scope`, `credential_kind` (it also serves MCP grants). |
| `decision` | `ratelimit.check` | `apps/api/internal/httpapi/rate_limit.go:259` | Refusals only: `limiter_unavailable` (260-265), `exhausted` (267-279); inputs `policy`, `api_key_id`. |
| `decision` | `episode.create.live_limit` | `apps/api/internal/adapters/postgres/tenant_limits.go:23` | `refused`, `live_episode_limit_reached`, `{live_count, limit}`. |
| `decision` | `episode.admission.capacity` | `apps/api/internal/adapters/postgres/episode_lifecycle_create.go:217-222`, `apps/api/internal/adapters/postgres/episode_lifecycle_create.go:305-310` | `refused`, `capacity_exceeded`, `{admission: direct or knock}`. The query can't say which limit failed, so the checker counts Participants itself. |
| field | `grant_kind` | `apps/api/internal/httpapi/access_grants.go:117-119` | `initial` or `renewal` per section 1, passed through `LogAccessGrantFailure` (`apps/api/internal/observability/http.go:264-269`). |

## 6. Fault scenarios

Webhook URLs must be public HTTPS on port 443 (`apps/api/internal/webhooks/url.go:14-23`), so every scenario uses a temporary catcher token on `https://webhook.site`, created with `POST /token` and `{default_status, request_limit: 50}` the way `scripts/prod-proof/webhooks.mjs:105` does and deleted afterwards with `DELETE /token/<id>` (`scripts/prod-proof/cleanup.mjs:146`). Run all of them on the local dev stack, which sets `CHALK_API_REQUEST_LOGS=all` (`scripts/dev/chalk.mjs:149`), uses the built-in webhook key (`apps/api/internal/config/config.go:1099`) and keeps rate limits on by default (`apps/api/internal/config/config.go:458`). Start it with `CHALK_API_OTLP_ENDPOINT=https://api.axiom.co` and `OTEL_EXPORTER_OTLP_LOGS_HEADERS` for a non-production dataset (the credential from 1Password, never in Git), and run the checker with `CHALK_LOG_DATASET` set to that dataset. Before scenario 1, confirm one local `http.request` row arrives there within 2 min; if none does, stop and report. Use one endpoint subscribed to `episode.started` and one API key.

1. **Receiver refuses.** Catcher with `default_status: 401`. Create an Episode. A 401 isn't retryable, so the delivery is exhausted at attempt 1.
   ```
   episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
   F-xxxx webhook.not_delivered whd_xxxx +00:00..+00:01 hop=tenant_receiver module=tenant.receiver
   fact: state=exhausted attempts=1 last=http_4xx http_status=401 [db]; expected 2xx within 11 attempts by occurred_at+72h; db complete to asof
   hypothesis: receiver refused the signed request (stale secret or clock skew over 300 s); falsified by a 2xx on this endpoint within 10 min with no rotation
   ```
2. **Claim lock held.** Catcher with `default_status: 204`. In psql, run `select pg_advisory_lock(hashtextextended('<tenant uuid>', 0));` (the claim's key, `apps/api/db/queries/webhooks.sql:194`) and keep that connection open. Create an Episode. Run the checker at +02:30, release with `select pg_advisory_unlock_all();` at +04:00, and run it again at +05:00.
   ```
   episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
   F-xxxx webhook.delivery_stalled whd_xxxx +00:00..+02:30 hop=dispatcher_claim module=api.webhooks.dispatcher
   fact: state=pending attempt_count=0 waited 150s; no cycle_failed; endpoint in flight=0 tenant in flight=0 [db]; expected first attempt within 120s; db complete to asof
   hypothesis: Tenant claim lock held outside the dispatcher; falsified by an attempt row for this Tenant during the wait
   ```
   The second run prints `outcome=degraded` on line 1 and the range `+00:00..+04:0x`.
3. **Event row silently dropped.** Install `create function chalk_fault_drop() returns trigger language plpgsql as $$ begin return null; end $$;` and `create trigger chalk_fault_drop before insert on webhook_events for each row when (new.event_name = 'episode.started') execute function chalk_fault_drop();`. Create an Episode, run the checker after 30 s, then drop the trigger and the function.
   ```
   episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
   F-xxxx webhook.event_missing ep_xxxx +00:00 hop=api_fanout module=api.webhooks.producer
   fact: episodes.started_at=+00:00; endpoint enabled and subscribed before +00:00; no webhook_events row; fanout outcome=duplicate [api]; expected one row; db complete to asof
   ```
4. **Revoked key still in use.** Create a key (`apps/api/internal/httpapi/api_keys.go:124`), call `createSpace` with it once, revoke it with `DELETE` (`apps/api/internal/httpapi/api_keys.go:200`), then call `createEpisode` with it 3 times within 1 min and with no other key. Run the checker 6 min after the first refusal.
   ```
   tenant ten_xxxx <T0>..<T0+10m> outcome=broken coverage=complete asof=<t> rules=<n>
   F-xxxx integration.credential_refused ten_xxxx <T1>..<T1+1m> hop=api_key_auth module=tenant.backend
   fact: 3 requests 401 access.unauthenticated reason=revoked api_key=<uuid> [api]; api_keys.revoked_at=<T1-30s> [db]; no API-key success within 5m; expected 2xx; api complete to asof
   ```
5. **Burst over the write limit.** Confirm a write response carries `X-RateLimit-Limit` (`apps/api/internal/ratelimit/policies.go:15`); if it doesn't, stop and report. Create an Episode, wait 61 s, then send 70 `admitEpisodeParticipant` calls concurrently within 2 s and don't retry any 429. The token bucket refills 1 write a second, so at least 8 calls get 429.
   ```
   episode ep_xxxx outcome=broken coverage=complete asof=<t> rules=<n>
   F-xxxx integration.grant_not_issued ten_xxxx +01:0x hop=rate_limit module=tenant.backend
   fact: admit 429 request.rate_limited x<k> reason=exhausted api_key=<uuid> writes_60s=<n> retry_after=<s> [api]; no retry within 120s; expected retry after Retry-After; api complete to asof
   ```
   `<k>` is at least 8 and `<n>` at least 60.
6. **Healthy control.** Catcher with `default_status: 204`, endpoint subscribed to `space.created` and `episode.started`. Call `createSpace`, `createEpisode`, admit 2 Participants, issue each an initial grant, and call the endpoint test route (`apps/api/internal/httpapi/webhook_endpoints.go:68`). Don't end the Episode. Every delivery must be `succeeded` at attempt 1 within 120 s. Neither view may print any `webhook.` or `integration.` finding, any `gap:` line, `UNEXPLAINED` or `WITNESS_DISAGREEMENT`.
   ```
   episode ep_xxxx outcome=healthy coverage=complete asof=<t> rules=<n>
   tenant ten_xxxx <T0>..<T0+10m> outcome=healthy coverage=complete asof=<t> rules=<n>
   ```

## 7. Out of scope and traps

- Two records of one decision are one witness. Ledger rows share the transaction of the row they describe, the completion log copies `Complete`, and `last_used_at` copies the accepted authentication.
- A 2xx proves the receiver answered, not that it processed the event. A 4xx can't tell a bad signature (`sdks/typescript/client/src/webhooks/verify.ts:134`) or a stale timestamp (`sdks/typescript/client/src/webhooks/verify.ts:159`, tolerance 300 s at `sdks/typescript/client/src/webhooks/verify.ts:6`) from any other refusal, because `verifyWebhook` runs on the Tenant's server and its errors never reach Chalk.
- An empty query is never "no event expected". An endpoint edited after T is a gap. A Tenant with no endpoint rows is EXPECTED only because deleted endpoints stay readable for 30 days; don't widen the window past 30 days.
- An HTTP status alone never makes EXPECTED. Each EXPECTED above needs the checker's own `db` count or endpoint state as well.
- Webhook metrics carry no Tenant or delivery IDs. Don't add them, and don't read metrics in rules.
- `canceled` (`apps/api/internal/adapters/postgres/webhook_cancellation.go:39`), `erased` and `secret_rotated` fences are lifecycle choices, not failures.
- Never put the raw key, `key_prefix`, `key_hash`, `last_used_ip`, the webhook secret, the `webhook-signature` header, the endpoint URL or the event body in telemetry. Deliveries inject `traceparent` and never baggage (`docs/observability.md:11`). Add no redaction and remove no existing hash.
- Renewals and `media_token.*` codes are slice 7's, the embed is slice 1's, and recording and transcript events wait for slices 10 and 11. Don't edit Sync, C1 to C4 contracts, or production config. Don't wrap the dispatcher's poll, cleanup or health tickers (`apps/api/internal/webhooks/dispatcher.go:93-113`): they aren't boundaries.
- There's no TLA+ model of webhook delivery in `tools/formal/`, and this slice doesn't add one.
