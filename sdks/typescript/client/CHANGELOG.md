# Changelog

## Unreleased

- Add `media.captureCameraPreview()` to capture an unpublished camera track with the selected device and refresh the inventory after permission is granted. It shares live or pending camera capture; callers release a preview handle.
- Preserve access, Sync, SFU, and recovery failure codes and recoverability in join rejections, snapshots, and error events.
- Add `connection.sync_hello_timeout` for the Sync startup handshake deadline. Handle it alongside `connection.sync_start_failed` and retain a fallback for future codes.

## 5.0.0

- BREAKING: remove Episode diagnostics, client telemetry, feedback submission, RealtimeKit, public status, Tenant invitations, audit-log and Users API operations, and the regions catalog.
- BREAKING: replace `createChalkWhiteboardV1FileHttpTransport` with the download-only `createChalkWhiteboardV1FileDownloadTransport`. Remove the retired local file-upload API.
- Recover stalled whiteboard connections with a heartbeat watchdog. Use monotonic ages even when an injected wall clock moves backward. Persisted operation timestamps still use wall time.
- BREAKING: custom whiteboard `clock` objects must provide `monotonicNow()` on the same timeline as their `setTimeout` scheduler. A three-method clock now throws at construction. For real-time timers, add `monotonicNow: () => performance.now()`; for a virtual scheduler, return its elapsed time independently of wall-clock corrections.
- Publish and play shared tab audio separately from microphones, with share-audio state and coupled screen-share lifecycle.

- Add optional screen-capture surface/audio hints and actual selected surface/label metadata.
- Add explicit per-message reactions, versioned live/history state, offline queue support, and the shared 24-emoji set.
