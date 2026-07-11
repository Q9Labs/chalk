# Sync observability lab session log — 2026-07-11

- 15:20 PKT — Started implementation of a local browser lab for interacting with the real sync WebSocket server and observing client/server traces.
- 15:20 PKT — Read the global code standards, sync-server invariants, and browser verification workflow. Confirmed the repository has no Sites hosting configuration, so this belongs in `apps/sync` as a dev-only surface.
- 15:21 PKT — Chose a dev-only design: the sync server serves the lab assets, real participant panels connect to `/v1/sync`, and a separate trace WebSocket streams redacted structured server events from an in-memory bounded trace hub.
- 15:16 PKT — Added the dev-only trace hub, trace WebSocket, lab routes, multi-participant UI, readable trace, and raw protocol frame viewer.
- 15:17 PKT — The first test run exposed reversed Erlang queue arguments in the trace ring buffer. Fixed the crash and reran the suite successfully.
- 15:20 PKT — Split the browser logic into focused modules and verified both modules with Node syntax checks.
- 15:21 PKT — Ran the canonical sync gate: format, warning-free compile, Credo, and 41 tests all passed.
- 15:25 PKT — Post-commit review found stale reconnect cursors after manual room changes and duplicate retained trace entries after trace-stream reconnects. Fixed both by clearing participant cursors on every room transition and deduplicating trace records by timestamp and event ID.
- 15:29 PKT — Second review found that one received event advanced every simulated participant cursor and that trace deduplication keys were unbounded. Restricted cursor advancement to the receiving socket and capped deduplication at the server's 500-event history size.
