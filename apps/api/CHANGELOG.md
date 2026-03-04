# Changelog

## Unreleased

### Added

- **Debug diagnostics endpoints**: Add `GET /api/v1/debug/auth` (token/server/build introspection) and `HEAD /api/v1/debug/ping` (latency probe) for client System Health.

### Changed

- **Post-meeting webhook payloads**: Include participant metadata and external IDs in tenant webhook payloads for easier identification.
- **DB join hot-path indexing**: Add composite indexes on `rooms(tenant_id, name, created_at DESC)` and `participants(room_id, external_user_id, created_at DESC)` to reduce join/read-path latency.
- **Wide event logging for recording & webhook flow**: Replaced ~60 scattered `slog.Info/Debug/Error` calls with 5 canonical wide events (`recording.webhook_received`, `recording.process`, `recording.post_meeting`, `recording.webhook_delivered`, `recording.stalled_check`). Each event is emitted once per operation via `defer`, accumulating all context (IDs, durations, outcomes, errors) into a single structured log line queryable in Axiom. Removed `[chalk]` prefix convention — event names are self-describing.
- **OpenTelemetry tracing**: Added OTEL tracing middleware + outbound HTTP instrumentation and propagation into Whisper jobs via `traceparent`. Logs now include `trace_id`/`span_id`, and the API returns `X-Chalk-Trace-Id` for support/debug.
- **Cloudflare participant/meeting observability**: Added structured Cloudflare request logs (`operation`, `attempt`, `status_code`, `tenant_id`, `room_id`, `request_id`, elapsed timing) for `CreateMeeting` and `AddParticipant`, plus propagated request context from participant handler.
- **Redis cache for auth/join read paths**: Added short-TTL fail-open Redis caching for internal-owner tenant resolution in `GET /api/v1/internal/auth/access-token`, tenant config reads in participant join flow, and room-name to room-id mapping in `POST /api/v1/rooms/:id/participants` (positive cache only; no negative miss cache).

### Fixed

- **Axiom dataset default**: Use `chalk-api-prod` when `ENV=production` so prod logs don't 404 on missing datasets.
- **Whisper timeout false-failures under backlog**: Increased default API wait timeout to `2h` (from `30m`) and added timeout diagnostics (`job_id`, queue depth, processing queue depth) in error messages.
- **Axiom ingest spam guardrail**: If the configured dataset is missing/unauthorized, fall back to stdout logger instead of retry-spamming stderr.
- **Gin release mode**: Force Gin into release mode when `ENV=production` so ECS doesn't run with verbose debug logging.
- **API key auth latency**: `POST /api/v1/auth/token` and `X-API-Key` middleware now avoid loading full tenant configs and parallelize API-key verification, preventing API Gateway 30s timeouts under large tenant counts.
- **Join-room observability on Cloudflare failures**: `POST /api/v1/rooms/:id/participants` now enforces request-level context timeout and logs Cloudflare `create meeting`/`add participant` failures with operation, status, body, and stack-backed request correlation metadata so 5xx incidents are attributable in Axiom.
- **Cloudflare transient failure handling**: Added bounded retries with backoff+jitter for `CreateMeeting` and `AddParticipant`, and map participant join Cloudflare failures to `503` (or `502` for upstream 4xx) with request correlation in API responses.
- **Redis shutdown race**: Server shutdown now cancels worker context first and waits for goroutines to exit before closing router/Redis resources, preventing `redis: client is closed` errors during termination.
- **WebSocket reader EOF noise**: Benign read EOF/network-close disconnects now classify as peer disconnects (not internal 1011), with dedicated metrics counters for `read_eofs` and `read_errors`.
