# Changelog

## Unreleased

### Changed

- **Post-meeting webhook payloads**: Include participant metadata and external IDs in tenant webhook payloads for easier identification.
- **Wide event logging for recording & webhook flow**: Replaced ~60 scattered `slog.Info/Debug/Error` calls with 5 canonical wide events (`recording.webhook_received`, `recording.process`, `recording.post_meeting`, `recording.webhook_delivered`, `recording.stalled_check`). Each event is emitted once per operation via `defer`, accumulating all context (IDs, durations, outcomes, errors) into a single structured log line queryable in Axiom. Removed `[chalk]` prefix convention — event names are self-describing.

### Fixed

- **Axiom dataset default**: Use `chalk-api-prod` when `ENV=production` so prod logs don't 404 on missing datasets.
- **Axiom ingest spam guardrail**: If the configured dataset is missing/unauthorized, fall back to stdout logger instead of retry-spamming stderr.
