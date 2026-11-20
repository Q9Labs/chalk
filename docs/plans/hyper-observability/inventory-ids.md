## 1. Correlation identifiers

I fetched `origin`; this report is against `origin/master` at `a09ae423297daaf07d5ea565ead742198030b12e`.

- **Journey / operation trace:** The API accepts `x-chalk-journey-id`, or mints a UUID if absent, returns it, puts it in context, and starts a journey span (`apps/api/internal/observability/journey.go:20`). SDK telemetry sends a `traceparent` and `client_session_id`, but the docs say clients do **not** send a journey ID; each API request therefore gets its own journey (`sdks/typescript/client/src/telemetry/outbox.ts:55`, `docs/observability.md:7`). A journey is not the same as an SDK telemetry session.
- **W3C trace/span:** The SDK outbox creates one `traceparent` at construction; API and Sync propagate W3C trace context. Sync accepts `traceparent`/`tracestate` with journey fields and can persist/reconstruct trace context (`sdks/typescript/client/src/telemetry/outbox.ts:55`, `apps/sync/lib/chalk_sync/observability/correlation.ex:26`). The docs describe an intended request-ID/trace-ID relationship, but the actual API journey middleware mints a journey ID independently of the incoming trace context (`docs/observability.md:7`).
- **Telemetry client session:** `sessionId`/`client_session_id` is minted once per outbox, which belongs to one SDK client from before first join to disposal. Sent as SDK telemetry body field and as W3C baggage `session.id` on API requests/Sync hello; it is deliberately not persisted as durable work (`sdks/typescript/client/src/telemetry/outbox.ts:25`, `docs/observability.md:8`). Do not conflate with product/dashboard `sessionId` or Cloudflare session.
- **Telemetry event sequence / operation:** Outbox maintains `#seq` and event IDs; call operation telemetry uses `operation_id`. These are SDK event/operation identities, not API request IDs. Rows are stamped with credential-derived Tenant, Space, Episode, provider session and SHA-256 participant hash; the client does not supply those identity fields (`sdks/typescript/client/src/telemetry/outbox.ts:44`, `apps/api/internal/httpapi/telemetry.go:90`). The hash is SHA-256 of the Participant UUID string, not a separate database key.
- **Participant and generation:** Participant ID is authoritative in access-grant subject; generation fences a particular admission/seat incarnation. They flow through API grants and Sync identity/protocol fields. API telemetry replaces raw participant ID with `participant_id_hash`; provider’s connection identity is `provider_session_id` (`apps/api/internal/httpapi/telemetry.go:97`). Same field `session_id` is overloaded elsewhere for domain room/Episode session IDs.
- **Admission/join:** `admission_request_id` identifies a pending admission request; Participant ID plus `generation` identify the admitted seat incarnation. These are distinct from journey and telemetry session (`apps/api/db/schema.sql:534`, `apps/sync/lib/chalk_sync/observability/correlation.ex:74`).
- **Media / SFU:** The API grant distinguishes `connection_id` and `cloudflare_connection_id`; API telemetry calls provider’s connection `provider_session_id`. Participant media connection/generation is per media connection. `connection_id` is the stable cross-plane join key where propagated; SFU journal exports `participant_id`, `connection_id`, `trace_id` (`apps/api/internal/accessgrants/verifier.go:55`, `docs/observability.md:142`).
- **Recorder/transcription/webhooks:** Recorder work carries `tenant_id`, `episode_id`, `recording_id`, `job_id`, `attempt`, `capture_epoch`; claim response carries Episode `journey_id` and `trace_id`, otherwise falls back to claim request ID as journey. Transcription retains journey/`traceparent` on render admission (`docs/observability.md:204`). Webhook delivery IDs and durable lifecycle identifiers exist, but not all worker hops carry a common client/session identifier; the docs explicitly advise joining worker events by job and attempt (`docs/observability.md:17`).
- **Breaks/collisions:** Session baggage is intentionally dropped before durable work and Sync response frames; per-request journey IDs differ from the client’s longer-lived telemetry session (`docs/observability.md:8`). “Session” names domain room sessions, media-provider sessions, and SDK telemetry sessions.

## 2. Identity lookups

- `participants.name` is nullable display name; no tenant-provided external ID is on Participant. Participant links to `identities` via `identity_id`; `identities.external_id` and `display_name` are stored and unique by `(tenant_id, external_id)` (`apps/api/db/schema.sql:318`, `apps/api/db/schema.sql:534`).
- Tenant has `id` and `name`; no tenant slug appears in its table definition (`apps/api/db/schema.sql:2`). Identity lookup index/constraint is `(tenant_id, external_id)`, not display name. Space has a slug, which is a different concept (`apps/api/db/schema.sql:229`).
- Telemetry hash is an unkeyed SHA-256 of Participant UUID; it can be mapped by hashing known Participant UUIDs, but telemetry does not provide a direct query key or store a hash-to-row mapping (`apps/api/internal/httpapi/telemetry.go:97`).

## 3. Central instrumentation today

- **API:** Shared OTel bootstrap and HTTP request/journey middleware exist; only emits when OTLP endpoint is configured (`apps/api/internal/observability/otel.go:40`, `apps/api/internal/observability/journey.go:20`). Not every operational command/worker is an HTTP request.
- **Sync:** Shared observability/correlation modules and `:telemetry` instrumentation exist, but event logging remains module-owned; protocol fields carry W3C/journey context selectively (`apps/sync/lib/chalk_sync/observability/correlation.ex:17`).
- **SDK/web/mobile:** SDK provides `ConnectionDiagnostics` and one telemetry outbox, but diagnostics require callsites to record events; web uses the SDK’s web telemetry platform (`sdks/typescript/client/src/connection/diagnostics.ts:75`, `sdks/typescript/client/src/space-client/core.ts:43`).
- **SFU/workers:** SFU has a bounded exporter/journal and field allowlist; recorder binaries use `observability.StartWorker` (`docs/observability.md:142`). A search for direct `slog`/`Logger`/`console` emit calls across API internal, Sync lib and SFU internal found 125 matching source lines; that is an upper bound, not a count of confirmed bypasses.
- **Schema/codegen:** No single cross-language observability event schema found. API telemetry and Sync protocol contracts have generated artifacts, but instrumentation/event schemas are module-specific; search covered observability directories and generated contract paths.

## 4. Version, build and feature flags

- API OTel resource uses configured service/version/environment, with defaults `chalk-api`/`dev`/`local`; recorder worker reads `CHALK_RECORDER_VERSION`, environment and endpoint (`apps/api/internal/observability/otel.go:51`, `apps/api/internal/observability/worker.go:53`).
- TypeScript SDK package version is `5.5.0` (`sdks/typescript/client/package.json:3`); Sync has Mix version `0.1.0` (`apps/sync/mix.exs:7`). Search did not establish a single build SHA/version source spanning web, Sync, SFU and dispatcher.
- No general feature-flag service found. Feature switches are configuration/database kill switches; API has `CHALK_SFU_NEW_EPISODES` deploy-time floor and DB-backed media-plane kill switch (`apps/api/internal/config/config.go:287`, `apps/api/internal/spaces/media_plane_setting.go:33`).

## 5. Release path

- `origin/master` is the `a09ae423…` commit named in the request. Current infra includes Alchemy entrypoints for SFU and transcription dispatcher (`infrastructure/sfu/alchemy.run.ts`, `infrastructure/transcription-dispatcher/alchemy.run.ts`); recorder also has an Alchemy entrypoint (`infrastructure/recorder/alchemy.run.ts`).
- Recorder release marker could be emitted from the deployment/release flow or worker startup with release/build identity; dispatcher has explicit release ID and artifact digest inputs (`infrastructure/transcription-dispatcher/policy.ts:80`). No shared deploy/release event found in observability code or docs search. Rollback marker likewise none found.

## 6. Client timers

- Correction: SDK call-stats window is **10 seconds**, not 30; sampling is closed when a report arrives after the window, rather than by a periodic interval (`sdks/typescript/client/src/media/call-stats.ts:8`).
- Outbox uses `globalThis.setTimeout` (routine delay 1.5s, stats delay 30s, backoff up to 60s), so browser background throttling can delay it; no Worker usage found in the SDK path (`sdks/typescript/client/src/telemetry/outbox.ts:7`).
- React Native uses JS timers; OS background suspension can pause JS/timers. No background timer/wake mechanism found in mobile app sources.

## 7. Access grant renewal

- Grant lifetime is 5 minutes (media credential type, as referenced); SDK refresh window is configurable with `DEFAULT_REFRESH_WINDOW_MS`, and it schedules renewal against the earlier of Sync/media expiries (`apps/api/internal/accessgrants/types.go:32`, `sdks/typescript/client/src/access/manager.ts:49`).
- Rejection can trigger forced `access_retry`; renewal/reconnect handling is in lifecycle, not a periodic timer loop (`sdks/typescript/client/src/access/manager.ts:91`).
- Outbox retries 401 after one credential refresh; retryable transport/429/5xx restores batch and uses exponential full-jitter backoff up to 60s. If credential is permanently unavailable for a queued subject, events are discarded and counted; queue pressure can also drop/fold events (`sdks/typescript/client/src/telemetry/outbox.ts:186`).

## 8. Database health

- No Postgres exporter, `pg_stat_statements`, slow-query configuration, `pgxpool.Stat()`/pool metrics or pool-metric instrumentation found in API search. Search terms: `pgxpool.*Stat`, `.Stat()`, `pg_stat_statements`, `log_min_duration_statement`, `slow.query`, `DBStats`, `pool.*metrics`.
