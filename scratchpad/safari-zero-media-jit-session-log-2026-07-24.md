# Safari zero-media JIT connection replacement session log

- 2026-07-24 20:48 PKT — Reproduced the lifecycle difference in code: an
  empty local stream bypassed SDP negotiation but still moved the media
  snapshot to `live`; the first later screen publication therefore used the
  original dormant Cloudflare connection.
- 2026-07-24 20:57 PKT — Confirmed Cloudflare's documented five-second
  connected-PeerConnection requirement and the first-offer lifecycle, then
  scoped the correction to a just-in-time participant-access connection
  replacement rather than a fake audio/video publication.
- 2026-07-24 21:10 PKT — Wired the dormant replacement callback from
  `ChalkSessionAccessManager` through the production media factory and made the
  media client replace only an unnegotiated connection before its first later
  local publication. Added Safari-like MID assignment and focused empty-join,
  already-negotiated, retry, and access-plumbing coverage.
- 2026-07-24 21:10 PKT — Verification passed: all 43 TypeScript client test
  files (254 tests), `tsc --noEmit`, and focused `oxfmt --check`.
- 2026-07-24 21:16 PKT — Extended dormant replacement through the first
  remote-track pull. A physical PeerConnection epoch now invalidates events
  from the closed connection without changing the logical recovery generation,
  so the completed remote reconciliation and polling lifecycle remain current.
  A concurrent first remote pull and first screen publication serialize through
  one replacement and both use the fresh connection. Verification passed with
  all 43 TypeScript client test files (255 tests), `tsc --noEmit`, focused
  formatting, and `git diff --check`.
