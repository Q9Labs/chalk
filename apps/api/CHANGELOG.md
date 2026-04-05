# Changelog

## Unreleased

### Added

- **Debug diagnostics endpoints**: Add `GET /api/v1/debug/auth` (token/server/build introspection) and `HEAD /api/v1/debug/ping` (latency probe) for client System Health.
- **Room scheduling endpoint**: Add `POST /api/v1/rooms/schedule` to create scheduled rooms with `scheduled_start_at`, optional `scheduled_end_at`, and per-room `allow_early_join_minutes`.
- **Durable room chat endpoints**: Add room-scoped chat attachment upload/download endpoints plus durable message/read-receipt persistence for in-room chat.
- **Screen annotation room state**: Add websocket `annotation.*` protocol handlers, persisted `rooms.screen_annotation_state`, and host/sharer access enforcement for live shared-screen annotations.

### Changed

- **Cloudflare post-meeting transcription now runs through a queue-backed Worker**: the API `cloudflare` provider dispatches signed jobs to `infrastructure/cloudflare-worker`, Cloudflare Queue + DLQ handle retries/terminal failures, and signed callbacks update Chalk before AI summary and tenant webhook delivery continue.
- **Post-meeting webhook payloads**: Include participant metadata and external IDs in tenant webhook payloads for easier identification.
- **First-party auth scope now resolves shared tenant + personal workspace**: internal Chalk auth now issues first-party tokens with `workspace_id`, creates/reuses a personal workspace per user inside a shared internal tenant, scopes dashboard meeting/recording queries by workspace, and writes new first-party rooms with `workspace_id`/`created_by_user_id` instead of relying on per-user internal tenants.
- **DB join hot-path indexing**: Add composite indexes on `rooms(tenant_id, name, created_at DESC)` and `participants(room_id, external_user_id, created_at DESC)` to reduce join/read-path latency.
- **Room snapshots with durable chat**: Direct room snapshots can now hydrate durable chat history while fanout snapshots stay lean for participant state churn.
- **Wide event logging for recording & webhook flow**: Replaced ~60 scattered `slog.Info/Debug/Error` calls with 5 canonical wide events (`recording.webhook_received`, `recording.process`, `recording.post_meeting`, `recording.webhook_delivered`, `recording.stalled_check`). Each event is emitted once per operation via `defer`, accumulating all context (IDs, durations, outcomes, errors) into a single structured log line queryable in Axiom. Removed `[chalk]` prefix convention — event names are self-describing.
- **OpenTelemetry tracing**: Added OTEL tracing middleware + outbound HTTP instrumentation and propagation into Whisper jobs via `traceparent`. Logs now include `trace_id`/`span_id`, and the API returns `X-Chalk-Trace-Id` for support/debug.
- **Cloudflare participant/meeting observability**: Added structured Cloudflare request logs (`operation`, `attempt`, `status_code`, `tenant_id`, `room_id`, `request_id`, elapsed timing) for `CreateMeeting` and `AddParticipant`, plus propagated request context from participant handler.
- **Redis cache for auth/join read paths**: Added short-TTL fail-open Redis caching for internal-owner tenant resolution in `GET /api/v1/internal/auth/access-token`, tenant config reads in participant join flow, and room-name to room-id mapping in `POST /api/v1/rooms/:id/participants` (positive cache only; no negative miss cache).
- **WebSocket whiteboard protocol now v2-only (breaking)**: removed legacy v1 update/persist compatibility (`WhiteboardUpdatePayload`, v1 persisted restore fallback), and normalized whiteboard data/snapshot payloads to always include required v2 fields (`schema_version`, `scene_id`, `sync_all`, `updated_at_ms`).
- **Scheduled room lifecycle**: Rooms now support `scheduled` status and first-class schedule fields (`scheduled_start_at`, `scheduled_end_at`, `allow_early_join_minutes`); participant join flow auto-activates scheduled rooms on first allowed join and rejects joins before the configured early-join window.

### Fixed

- **Cloudflare transcription OOM path**: removed the in-process Workers AI upload path that buffered full recordings in API memory and replaced it with callback-based completion plus provider job/error metadata on `post_meeting_transcripts`.
- **Hosted first-party auth bootstrap + client incident CORS**: hosted Chalk web clients now reuse a stable bootstrap identity even when cross-site cookies drop between requests, and the debug incident endpoint now explicitly allows `x-chalk-source` so browser incident reports from `chalkmeet.com` do not fail preflight.
- **First-party room joins no longer fork Cloudflare meetings by auth context**: signed join-token exchange now preserves canonical `room_id`, first-party room joins reject room-name fallback/auto-create behavior, and authenticated users now converge on the original room/meeting instead of silently creating a second tenant-scoped room behind the same visible code.
- **First-party room creation no longer explodes on non-user host subjects**: room create/schedule now only stamp `created_by_user_id` for workspace-scoped user claims, so host/API-key and claim-based tokens stop tripping `rooms_created_by_user_id_fkey` during room creation.
- **Embedded DB migrations**: Runtime migrations now include `010`–`012`, preventing local/prod drift where durable chat tables were missing even though migration files existed on disk.
- **Axiom dataset default**: Use `chalk-api-prod` when `ENV=production` so prod logs don't 404 on missing datasets.
- **Whisper timeout false-failures under backlog**: Increased default API wait timeout to `2h` (from `30m`) and added timeout diagnostics (`job_id`, queue depth, processing queue depth) in error messages.
- **Axiom ingest spam guardrail**: If the configured dataset is missing/unauthorized, fall back to stdout logger instead of retry-spamming stderr.
- **Gin release mode**: Force Gin into release mode when `ENV=production` so ECS doesn't run with verbose debug logging.
- **API key auth latency**: `POST /api/v1/auth/token` and `X-API-Key` middleware now resolve tenant API keys through an indexed deterministic lookup hash plus one bcrypt verification, and legacy keys self-promote onto the fast path after first successful use instead of scanning every active tenant hash on each cache miss.
- **Join-room observability on Cloudflare failures**: `POST /api/v1/rooms/:id/participants` now enforces request-level context timeout and logs Cloudflare `create meeting`/`add participant` failures with operation, status, body, and stack-backed request correlation metadata so 5xx incidents are attributable in Axiom.
- **Cloudflare transient failure handling**: Added bounded retries with backoff+jitter for `CreateMeeting` and `AddParticipant`, and map participant join Cloudflare failures to `503` (or `502` for upstream 4xx) with request correlation in API responses.
- **Redis shutdown race**: Server shutdown now cancels worker context first and waits for goroutines to exit before closing router/Redis resources, preventing `redis: client is closed` errors during termination.
- **WebSocket reader EOF noise**: Benign read EOF/network-close disconnects now classify as peer disconnects (not internal 1011), with dedicated metrics counters for `read_eofs` and `read_errors`.
