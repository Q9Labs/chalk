# Changelog

## Unreleased

### Changed

- **Wide event logging for recording & webhook flow**: Replaced ~60 scattered `slog.Info/Debug/Error` calls with 5 canonical wide events (`recording.webhook_received`, `recording.process`, `recording.post_meeting`, `recording.webhook_delivered`, `recording.stalled_check`). Each event is emitted once per operation via `defer`, accumulating all context (IDs, durations, outcomes, errors) into a single structured log line queryable in Axiom. Removed `[chalk]` prefix convention — event names are self-describing.
