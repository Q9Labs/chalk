# Changelog

## 5.0.0

- BREAKING: remove Episode diagnostics, feedback submission, RealtimeKit, public status, Tenant invitations, audit-log and Users API operations, and the regions catalog.
- Recover stalled whiteboard connections with a heartbeat watchdog. Use monotonic ages even when an injected wall clock moves backward. Persisted operation timestamps still use wall time.
- Publish and play shared tab audio separately from microphones, with share-audio state and coupled screen-share lifecycle.

- Add optional screen-capture surface/audio hints and actual selected surface/label metadata.
- Add explicit per-message reactions, versioned live/history state, offline queue support, and the shared 24-emoji set.
