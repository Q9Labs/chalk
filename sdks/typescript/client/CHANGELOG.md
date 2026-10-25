# Changelog

## 5.2.0

### board-draw-policy

Add a call-wide drawing policy for the board: everyone, only hosts, or picked people.
Hosts set it with `setDrawPolicy` on the whiteboard transport and pick people with the
existing `setDrawPermission`. Sync computes each person's permission and sends it with
the policy over the new `draw_policy_v1` extension, so the summary and
`useWhiteboard().access` now carry `canDraw`, `drawPolicy` and the host's per-person
choices. The React board follows that permission instead of the role capability, and
hosts get a "Who can draw" section with a person picker in the board menu.

The whiteboard client now steps its hello down only when Sync can't decode it (close
1009). A rejected token or a late hello (close 1008) is retried at the same level up to
four times, so a brief token problem no longer hides the drawing policy for the rest of
the connection. On a Sync without the drawing policy, a host's waiting policy change is
refused as `unavailable`, and also reported on the summary, instead of being replayed.

### confirmed-call-entry

Count a person in a call only after they have fully entered it. The built-in
browser and React Native Sync clients ask Sync for entry confirmation on the Sync
URL (`entry_confirmation=1`). When Sync's `welcome` grants it, the client sends
`entered` once Sync is live and media has started, so a failed connection no
longer leaves a ghost participant or an attendance record. Against an older Sync,
the client sends the previous hello and Sync confirms entry at hello as before.

`confirmEntered()` on a custom `createSyncClient` implementation is optional.
Implementing it, and building `V1SyncClient` with `entryConfirmation: true`, adds
the confirmed entry above. Without it, the client never asks for entry
confirmation and Sync confirms the entry at hello, as in 5.0.x. `V1SyncClient`
asks only when it is built with `entryConfirmation: true`.

When entry fails, the client cancels the pending admission through the new
`cancelEpisodeParticipantJoin` endpoint (`POST .../participants/:participant_id/cancel-join`),
and a retry keeps the same person. If Sync reports `entry timeout` because the
pending seat expired before entry, the connection fails as a retryable
`sync_start_failed` instead of rejected access, and the client does not reconnect
the expired seat with the same grant.

The admission contract declares the 409 `participant.not_active` response when
a retried admission names a participant that has already left. The public
`AdmitEpisodeParticipantError` union stays compatible with 5.1.0; this response
uses the existing `HttpClientError` channel, with its code in the response body.
The dashboard reads that code and retries once with a fresh join key.

Sync assigns each entry a participant-local generation and returns it in
`welcome`. The client resumes that generation through the `entry_generation`
WebSocket query, even after refreshing its credential. Confirmation advances
ownership only forward and voids older pending Leaves. Acceptance and completion
both fence a Leave against the confirmed generation, so reattaching the same
seat cannot let the previous mount remove it. Previous Sync ignores this query.
Legacy sockets receive a server generation internally without changing their
welcome frame, and still confirm at hello. Participants created before seat
storage acquire it on their first live hello. When recovery replaces the Sync
client, it confirms the replacement entry before reporting recovery complete.
Completed startup also survives reconnecting from an older Sync to an upgraded
one. Recovery can finish while a previous entry's Leave is pending, and an
uncertain confirmation reply checks that entry's generation before acknowledging it.
A claimed Leave blocks later entry
admission until its provider work settles. An entry admitted before that claim
defers the older provider work until confirmation or its two-minute startup
lease expires, preventing old cleanup from closing the new entry's media.

Rollout: apply the database migrations first, then upgrade Sync, then the API and
this client. This client also works with an older Sync, and published 5.0.x
clients keep hello confirmation with the new Sync.

### follow-view-owner

Converge Follow views on one Episode owner, recover from its canonical snapshot,
and preserve real camera moves during recovery and tab switches. Zoom controls
and keyboard moves now consistently leave Follow and lead the person's view.

Keep all 500 active people's views using internal schema-generated limits in the client and React caches. The client's public bounds, event unions and decoded-frame unions are unchanged. The client now exports `ChalkWhiteboardViewVersions`, which the React SDK uses to order view moves, and whiteboard view events now carry `ownerId`, `ownerSequence` and `originEpoch`, so both releases are minor.

### honest-chat-file-errors

Report chat attachment network and browser access failures without blaming storage.
Keep token acquisition failures separate with a diagnostic stage while preserving
the published error codes and original cause. Preserve recoverable access and
connection failures through SpaceClient, including signed storage uploads. Show
the storage-unavailable message only when a readable 503 response confirms
`chat.storage_unavailable`.

### problem-reporting

Add the problem-report API contract and reusable report dialog, with opt-in diagnostics,
editable delivery failures and bounded Unicode input. Call details and failed or ended
call screens can expose reporting when an integration supplies a delivery callback.
Use `reportUnavailableReason` to show expired access inside an editable report.
Live report drafts survive call termination. Integrations with their own terminal
screens can use `onOpenReportProblem` to keep one app-owned dialog across those screens.
Give `ReportProblemDialog` a `focusScope` containing the current call or terminal screen,
so closing it returns focus to its usable opener, or to a visible current control
when the opener has disappeared. Hidden, inert and disabled targets are skipped.

### recording-auto-render

Expose recording expiry reasons through additive failure fields while preserving the existing export status enum.

Add the Tenant recording_render_mode setting, defaulting to on_demand, with opt-in automatic MP4 rendering.

### recording-transcription-expiry

Recordings now report when their transcription source expires, as
`transcription_preparation.expires_at`. A transcript can be requested only
while `transcription_preparation.status` is `ready` and this time is ahead. It
is never later than `source.expires_at`, and it can be much earlier, because a
Space's transcription source window is often shorter than its video retention. The field is
absent when transcription is disabled or no transcription source exists yet.

### space-activity-read

Add `spaces.listSpaceActivity` (`GET /v1/tenants/{tenant_id}/space-activity`) and
its generated schemas and types. One read returns, for up to 300 Spaces, whether each
is archived, the live Episode with its full participant count and first five Participants, the latest
Episode with its status and start and end times, and up to five Participants who
most recently joined that Episode. It needs `episodes:read`; an unknown or other
Tenant's Space returns `404` for the whole batch. Existing operations are unchanged.

### sync-connect-diagnostics

Report Sync connection failures with the existing `connection.sync_hello_timeout` code without adding values to the public `ErrorCode` union. Add the current attempt's safe diagnostics to client errors, telemetry, and the call failure reference: opening/hello stage, close code and bounded reason, whether the socket opened, and elapsed time. Earlier attempts remain in the diagnostic history. Browsers do not expose DNS, TCP, or TLS progress. Unrecognized peer reasons are redacted. This is a compatible patch for the next client and React releases; released 5.1.0 files are unchanged.

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
