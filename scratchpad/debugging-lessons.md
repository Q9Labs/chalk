# Debugging And RCA Lessons

## Join And Reconnect Diagnostics

Several join failures were difficult to reason about until the SDK exposed a
structured timeline. The useful lesson is that the join path needs phase-level
events across UI intent, room lookup, participant creation, RealtimeKit
preload/join, websocket lifecycle, and media transport state.

Useful public guidance:

- capture compact structured events, not raw user/session logs
- include outcome, duration, phase, and sanitized error excerpts
- distinguish room resolution failures from participant join failures and
  transport/media failures
- avoid logging tokens, tenant identifiers, room identifiers, IP addresses, or
  raw websocket URLs

## Debug Reports

Debug exports should be safe by construction. They should redact obvious token
fields, compact noisy timelines, and summarize browser/network hints without
capturing raw personal or tenant-specific data.

## Websocket Transport

Reconnect and websocket investigations showed that public SDK behavior should
not depend on private app retry assumptions. The SDK should expose enough state
to make reconnect attempts, close/error events, and token refresh behavior
visible to callers without making consumers parse raw logs.

## Mobile Rendering And Media

Mobile work surfaced several recurring patterns:

- prejoin screens need resilient preview fallbacks when native media is not
  ready
- last-frame and media-visibility bugs often come from lifecycle transitions,
  not just track state
- device and simulator checks are necessary for camera, screen share, and
  native meeting panels
- native surfaces should fail into explicit UI states rather than blank screens

## Incident Lessons

Durable incident memory:

- stale or mismatched release configuration can masquerade as SDK runtime
  failure
- deploy verification should prove both artifact version and live behavior
- queue/worker systems need terminal failure semantics and observable retries
- public status or incident systems should avoid leaking implementation detail
  while still providing useful customer-facing updates
