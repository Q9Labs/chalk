## 2026-03-26 12:18 PKT

- Investigated mobile diagnostics dump for chat, reactions, hand raise, and screen share failures.
- Root cause 1: post-join room session kept using root auth provider for API refresh + WS reconnect. Symptoms matched `WebSocket not connected`, `ws reconnecting`, reaction failure, and likely missing hand-raise propagation after reconnect.
- Fix: added room-scoped session token provider on join; rewired API client + WS reconnect path to use joined access/refresh tokens.
- Root cause 2: RTK React Native can expose real remote screen-share tracks while `screenShareEnabled` remains stale/false.
- Fix: participant mapping now derives `isScreenSharing` from RTK screen-share tracks / producers in addition to the boolean flag.
- Added regression coverage for session token refresh handoff, WS reconnect using updated provider, join-session auth handoff, and remote screen-share stale-flag recovery.
- Full `@q9labs/chalk-core` test + typecheck green after compatibility guard for older shallow API client test doubles.
