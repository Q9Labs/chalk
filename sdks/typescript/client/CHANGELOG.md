# Changelog

## 5.1.0

- Add shared board views: `ChalkWhiteboardView`, `ChalkWhiteboardViewBounds`, and the whiteboard client's `supportsViews` and `sendView()`, so participants can follow a person's board view or bring everyone to theirs. The board stream also carries a `view` event.
- Export `isChalkAccessGrantError` and the `ChalkAccessGrantErrorCode` type from the server entry point. `ChalkAPIError.code` now includes the known media-token codes, such as `media_token.expired`.
- Admission responses add `decision_state` and an optional `decision_action`, so dashboard hosts see public invite knocks and a call that ends shows without a reload. Hosts can admit simultaneous knocks without reconnecting.
- Public invite reads (`getSpacePublicInvite`, `getSpacePublicInviteArrival`, `listSpacePublicAdmissionRequests`) move from `v1.authenticated.write` (60 per minute) to `v1.authenticated.read` (300 per minute) in the exported `ChalkOperationPolicies`.
- Calling `leave()` no longer closes media the server already ended.
- Recover a call when Sync rejects a state update, such as on a state digest mismatch. The client requests one fresh snapshot, validates it before replacing local state, and resumes; commands sent before or during recovery complete once. If that snapshot is rejected too, it stops reconnecting and fails with the new non-recoverable public code `connection.state_digest_recovery_failed`. Handle it like other terminal connection failures and offer a rejoin.
- Bound each Sync and whiteboard WebSocket opening attempt to 10 seconds by default. The whiteboard, and Sync once the call is live, retry a timed-out attempt through the existing reconnect backoff. During first join the Sync deadline ends with the default 10-second startup wait, so it does not retry a Sync socket that never opens: the join fails when the deadline expires. Late opens from expired attempts are ignored, and a redacted dial-timeout diagnostic is kept after recovery. The transports' existing options allow a longer deadline.
- Capture a fresh microphone when it is turned on after its previous track ended, instead of reusing the ended track.
- Report a chat send that Sync refuses for sending too fast as recoverable `command.rate_limited`, and one it refuses while overloaded as recoverable `collaboration.unavailable`, instead of non-recoverable `chat.payload_invalid`.
- Accept a server-selected media replacement during access refresh, including when the client clock still considers its prior credential valid, so rejoining with an expired media token works. The full participant subject check still runs before the client switches connections.
- Add optional Sync health to connection snapshots without changing the public status union. Brief pong loss degrades without blocking; sustained silence triggers recovery and stable pongs clear it. Reaction acknowledgements time out after five seconds and are not replayed.
- Guard media enabling at the controller boundary for every caller. Off intents are retained until Sync confirms them after reconnect, and media publication runs through revisioned workers so a late capture cannot enable a device after Off.
- Add `media.captureCameraPreview()` to capture an unpublished camera track with the selected device and refresh the inventory after permission is granted. It shares live or pending camera capture; callers release a preview handle.
- Exhausted media confirmations now return recoverable `media.timeout`; unrelated command retries are not classified as media failures.
- Reaction acknowledgement timeouts return recoverable `collaboration.unavailable` without claiming whether the reaction arrived.

- Preserve access, Sync, SFU, and recovery failure codes and recoverability in join rejections, snapshots, and error events.
- Add `connection.sync_hello_timeout` for the Sync startup handshake deadline. Handle it alongside `connection.sync_start_failed` and retain a fallback for future codes.
- Media changes while Sync is not live now return recoverable `connection.invalid_state` with plain connection guidance instead of an internal target error.

## 5.0.0

- BREAKING: remove Episode diagnostics, client telemetry, feedback submission, RealtimeKit, public status, Tenant invitations, audit-log and Users API operations, and the regions catalog.
- BREAKING: replace `createChalkWhiteboardV1FileHttpTransport` with the download-only `createChalkWhiteboardV1FileDownloadTransport`. Remove the retired local file-upload API.
- Recover stalled whiteboard connections with a heartbeat watchdog. Use monotonic ages even when an injected wall clock moves backward. Persisted operation timestamps still use wall time.
- BREAKING: custom whiteboard `clock` objects must provide `monotonicNow()` on the same timeline as their `setTimeout` scheduler. A three-method clock now throws at construction. For real-time timers, add `monotonicNow: () => performance.now()`; for a virtual scheduler, return its elapsed time independently of wall-clock corrections.
- Publish and play shared tab audio separately from microphones, with share-audio state and coupled screen-share lifecycle.

- Add optional screen-capture surface/audio hints and actual selected surface/label metadata.
- Add explicit per-message reactions, versioned live/history state, offline queue support, and the shared 24-emoji set.
