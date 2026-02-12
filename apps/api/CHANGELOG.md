# Changelog

## Unreleased

### Added

- **Debug diagnostics endpoints**: Add `GET /api/v1/debug/auth` (token/server/build introspection) and `HEAD /api/v1/debug/ping` (latency probe) for client System Health.

### Changed

- **Post-meeting webhook payloads**: Include participant metadata and external IDs in tenant webhook payloads for easier identification.
- **Wide event logging for recording & webhook flow**: Replaced ~60 scattered `slog.Info/Debug/Error` calls with 5 canonical wide events (`recording.webhook_received`, `recording.process`, `recording.post_meeting`, `recording.webhook_delivered`, `recording.stalled_check`). Each event is emitted once per operation via `defer`, accumulating all context (IDs, durations, outcomes, errors) into a single structured log line queryable in Axiom. Removed `[chalk]` prefix convention — event names are self-describing.
- **OpenTelemetry tracing**: Added OTEL tracing middleware + outbound HTTP instrumentation and propagation into Whisper jobs via `traceparent`. Logs now include `trace_id`/`span_id`, and the API returns `X-Chalk-Trace-Id` for support/debug.

### Fixed

- **Axiom dataset default**: Use `chalk-api-prod` when `ENV=production` so prod logs don't 404 on missing datasets.
- **Axiom ingest spam guardrail**: If the configured dataset is missing/unauthorized, fall back to stdout logger instead of retry-spamming stderr.
- **Gin release mode**: Force Gin into release mode when `ENV=production` so ECS doesn't run with verbose debug logging.
