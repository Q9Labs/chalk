# WebRTC Media and Reconnect Deep Dive

Date: 2026-05-30

Scope: Chalk SDK media join, Cloudflare RealtimeKit integration, WebSocket sync, device and screen-share flows, client reconnect UX, and production lessons from LiveKit, Jitsi, mediasoup, Twilio Video, AWS Chime SDK, and public Google Meet docs.

## Executive Summary

For a Zoom-like room, "connected" is not one thing. A participant can have an API participant row, an RTK signaling session, working ICE/DTLS media, a Chalk WebSocket, valid access tokens, active local device tracks, and a React UI phase. These can fail independently. Chalk has many of the pieces, but the current SDK mostly compresses them into one `SessionConnectionState`.

The highest-risk media problem is reconnect misclassification. The server currently treats any Chalk WebSocket close as a participant leave, while the client treats WebSocket close and RTK `roomLeft` as recoverable reconnect states. That creates false leaves, stale roster churn, empty-room cleanup hazards, and possible meeting end during transient network changes.

The second highest-risk problem is lack of an explicit media transport state vector. Chalk joins the API first, then RTK media, then WS sync. RTK reconnect events update the same status as WS events, and the React layer maps `disconnected` to a grace overlay. There is no canonical answer to "is media sending?", "is signaling reconnecting?", "did the server still consider this participant present?", or "is this a full rejoin vs ICE recovery?"

Production systems converge on a clear model:

- Twilio distinguishes room reconnecting/reconnected/disconnected and separates signaling vs media reconnection causes.
- LiveKit exposes room reconnecting/reconnected, connection quality, track publication, stream state, device errors, and recording/permission changes as separate events.
- AWS Chime SDK reports connecting vs reconnecting, started-after-reconnect, stopped-cleanly, stopped-with-failure, poor connection, and "suggest stop video" callbacks.
- mediasoup models ICE/DTLS transport as an explicit resource with state, stats, and `restartIce()`.
- Jitsi exposes `CONNECTION_INTERRUPTED`, `CONNECTION_RESTORED`, bridge bandwidth stats, Last N forwarding, and many conference/media state events.
- Google Meet public docs show user-facing recovery behavior: automatic troubleshooting, bandwidth reduction, device advice, Meet quality tooling, and participant sessions in the Meet API.

Chalk should introduce a `MediaConnectionVector` and a participant-session state machine. Keep the current simple SDK `status` for API compatibility, but derive it from richer state: room lifecycle, WS control channel, provider signaling, media transport, token health, device health, and participant-session authority.

## Current Chalk Findings

Line numbers refer to the local working tree on 2026-05-30.

### Join Order

The SDK joins in three phases:

1. API admission via `apiClient.addParticipant` in `packages/sdk-core/src/conference-client/join-session.ts:50`.
2. RealtimeKit init/join in `packages/sdk-core/src/conference-client/join-session.ts:103-116`.
3. Chalk WebSocket connection in `packages/sdk-core/src/conference-client/join-session.ts:129-135`.

After RTK join succeeds, `ConferenceSession` is created and seeded as connected because the RTK `roomJoined` callback already happened before listeners exist (`packages/sdk-core/src/conference-client/join-session.ts:118-127`). This is practical, but it means connection state is inferred from sequencing, not from a durable connection vector.

If join fails after API admission, the catch path disconnects only the local WebSocket object (`packages/sdk-core/src/conference-client/join-session.ts:153-156`). If RTK join never completed, the API participant can remain active unless the backend has separate cleanup. The meeting lifecycle report already identified this as part of the reconnect-vs-leave bug.

### RTK Join Retry

The actively used join engine is in `packages/sdk-core/src/conference-client/join-engine.ts`.

Good pieces:

- It classifies retryable RTK join errors such as "socket is not connected", "wrong state: closed", and "peer connection is closed" (`join-engine.ts:29`).
- It emits attempt telemetry with attempt number, timeout, delay, duration, outcome, and policy (`join-engine.ts:31-53`).
- When passed a factory, it creates a fresh RTK client per attempt and best-effort calls `leave()` on failed attempts (`join-engine.ts:123-190`).

Remaining gaps:

- The join engine handles initial join only. It does not define post-join media reconnect, ICE restart, provider token renewal, or full rejoin semantics.
- It returns a connected RTK client, but the rest of the SDK does not preserve join attempt identity or a media session generation.
- The repo still contains an older `rtk-runtime.ts` join helper that reuses a timed-out `joinPromise` on timeout (`packages/sdk-core/src/conference-client/rtk-runtime.ts:137-193`). If it is truly dead code, it should be removed to avoid future confusion; if any surface still imports it, it should be reconciled with the safer join-engine behavior.

### RTK Event Wiring

`setupRtkParticipantSync` wires RTK events into Chalk state in `packages/sdk-core/src/conference-session/rtk-participants.ts`.

Good pieces:

- `roomJoined` sets connection state to `connected`, syncs local media, prunes stale remotes, and reapplies background effects (`rtk-participants.ts:158-168`).
- `roomLeft` distinguishes intentional leave from provider failure. A failed room-left payload sets `failed` and emits a `CONNECTION_FAILED` error; otherwise it sets `reconnecting` (`rtk-participants.ts:170-195`).
- Remote participant snapshot reconciliation can prune stale remotes after RTK `roomJoined` (`rtk-participants.ts:49-87`).
- Media updates validate live tracks and emit local/remote telemetry (`rtk-participants.ts:197-360`).

Risks:

- RTK `participantLeft` immediately deletes a participant from the local map (`rtk-participants.ts:318-329`). For a production room, "remote participant temporarily reconnecting" should be distinct from "left". Twilio and LiveKit both expose reconnecting/lost-quality states before terminal leave.
- RTK and WS snapshots are competing projections. With RTK present, WS participant events are ignored for join/leave/update (`packages/sdk-core/src/conference-session/ws-signaling.ts:53-84`), but WS snapshots can still promote session state to connected (`ws-signaling.ts:188-205`). This is a pragmatic patch for race conditions, not a formal merge policy.
- `emitRoomSyncReady` fires once only (`packages/sdk-core/src/room.ts:267-281`). After reconnect, there is no second "sync healed" event or revision-based evidence that local state caught up.

### WebSocket Reconnect

`WSClientBase` has a real reconnect loop:

- States are `disconnected | connecting | connected | reconnecting | failed` (`packages/sdk-core/src/ws-client/constants.ts:7-9`).
- Delays are `[1000, 2000, 4000, 8000, 16000]` (`constants.ts:1`).
- Heartbeats run every 30 seconds with a 75 second timeout (`constants.ts:3-5`).
- On reconnect, it refreshes the token via the token provider before reconnecting (`packages/sdk-core/src/ws-client/base.ts:338-365`).
- After reconnect open, it requests `room.sync` (`base.ts:151-156`).

Main issue:

- The client sends `room.sync` with `lastSeq: this.now()` (`base.ts:153-156`). Server snapshots also use wall-clock milliseconds as `LastSeq` in the lifecycle report. This is not a durable event cursor. It cannot prove there was no gap, and it cannot replay missed control events.

Second issue:

- `getReconnectDecision` returns `noop` when state is already `reconnecting` (`packages/sdk-core/src/ws-client/connection-controller.ts:45-52`). That prevents duplicate scheduling, but it also means repeated heartbeat timeouts during a stuck reconnect do not advance attempts unless the scheduled timer fires. This may be fine, but tests should prove the long-tail behavior.

### Media Controls

`createConferenceSessionMediaController` owns camera, microphone, screen share, and background effects.

Good pieces:

- Local track validation checks `readyState === "live"` and `enabled` (`packages/sdk-core/src/conference-session/media-controls.ts:16-25`).
- Toggle operations emit wide events with before/after media state (`media-controls.ts:113-145`, `media-controls.ts:156-185`).
- Screen share handles user cancellation separately from hard failure (`media-controls.ts:241-279`).
- Screen share failure resets local share state and emits a specific Chalk error (`media-controls.ts:256-279`).
- Background effect reapply/suspend is integrated with video track updates and reconnect (`media-controls.ts:316-387`; `rtk-participants.ts:165-167`, `rtk-participants.ts:176-178`, `rtk-participants.ts:237-248`).

Risks:

- `boostVideoBitrate` reaches into private or semi-private RTK peer connection fields and forces max bitrate/scale-down values (`media-controls.ts:47-84`). This can fight provider congestion control, simulcast selection, mobile thermal limits, and SFU adaptation.
- Toggle operations optimistically mutate the local participant from RTK command success (`media-controls.ts:118-132`, `media-controls.ts:161-172`). There is no server-authoritative media command state, no command ID, and no reconciliation if the provider later reports a different result.
- Device switching uses optional `self.setDevice`, otherwise disable/enable fallback (`packages/sdk-core/src/conference-session/device-controls.ts:49-120`). It does not model `switching`, `failed`, `permission_denied`, `device_lost`, or `rollback_to_previous_device`.

### Diagnostics

Chalk has a useful RTK diagnostics snapshot:

- It extracts public state fields such as connection state, ICE state, signaling state, transport state, room joined flags, track state, participant collection sizes, and limitations (`packages/sdk-core/src/debug/rtk-diagnostics.ts:3-220`).

This is good scaffolding. The next step is to convert it from "debug export" into first-class runtime telemetry:

- State transitions with old/new state and cause.
- RTC stats deltas during reconnect.
- Token refresh timing.
- Time-to-first-audio/video.
- Time spent in reconnecting.
- Whether recovery was ICE restart, provider reconnect, or full API rejoin.

## Production Systems To Learn From

### Twilio Video

Source: <https://www.twilio.com/docs/video/reconnection-states-and-events>

Twilio's reconnection docs are directly relevant. They expose room-level `reconnecting`, `reconnected`, and terminal `disconnected` states. They explicitly distinguish signaling and media reconnect causes through error codes, and they warn that expired access tokens can cause reconnection failure.

Borrow for Chalk:

- Add `reconnect.cause = signaling | media | token | heartbeat | provider | unknown`.
- Emit `reconnected` as a real event, not just another `connected`.
- Preserve the user in a reconnecting participant state before terminal leave.
- Treat token refresh as part of reconnect, not a side concern.

### LiveKit

Sources:

- Room events: <https://docs.livekit.io/reference/client-sdk-js/enums/RoomEvent.html>
- Track management: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/tracks/>
- Advanced media, simulcast, Dynacast: <https://docs.livekit.io/transport/media/advanced/>

LiveKit's client API exposes a wide event surface: `Reconnecting`, `Reconnected`, `ConnectionStateChanged`, `ConnectionQualityChanged`, `TrackStreamStateChanged`, `TrackSubscriptionPermissionChanged`, `MediaDevicesError`, `AudioPlaybackStatusChanged`, and more. Its track docs separate `Track` from `TrackPublication`, so a room can know about a published track even when the local client is not subscribed or does not currently have a playable track.

Borrow for Chalk:

- Separate track publication state from local playable track state.
- Use connection quality/lost quality as a pre-terminal participant state.
- Prefer provider-managed simulcast/adaptive forwarding over client-side forced bitrate hacks.
- Surface device errors and audio playback permission as first-class SDK events.

### AWS Chime SDK

Sources:

- Lifecycle event conditions: <https://aws.github.io/amazon-chime-sdk-js/enums/meetingsessionlifecycleeventcondition.html>
- AudioVideoObserver: <https://aws.github.io/amazon-chime-sdk-js/interfaces/audiovideoobserver.html>

Chime explicitly distinguishes `ConnectingNew`, `ReconnectingExisting`, `StartedNew`, `StartedExisting`, `StartedAfterReconnect`, `StoppedCleanly`, and `StoppedWithFailure`. Its observer also reports poor connection, good connection, health changes, metrics, simulcast layer changes, and suggestions to stop video.

Borrow for Chalk:

- Make reconnect telemetry answer whether the user recovered an existing session or started a new one.
- Add a "suggest stop video" quality path instead of only showing connection-lost UI.
- Keep clean leave separate from failure in both SDK and server events.

### mediasoup

Source: <https://mediasoup.org/documentation/v3/mediasoup/api/>

mediasoup models WebRTC transport explicitly. A `WebRtcTransport` has ICE parameters, candidates, ICE state, selected tuple, DTLS state, SCTP state, stats, state-change events, and a `restartIce()` method.

Borrow for Chalk even though RTK owns the SFU:

- Treat "media transport" as an explicit resource with state, stats, and generation.
- If RTK exposes ICE restart or reconnect primitives, wrap them behind a Chalk `recoverMediaTransport()` command.
- If RTK does not expose them, model provider reconnect as a black-box state and use full RTK rejoin when it exceeds a threshold.

### Jitsi

Sources:

- Architecture: <https://jitsi.github.io/handbook/docs/architecture>
- lib-jitsi-meet conference events: <https://jitsi.github.io/lib-jitsi-meet/enums/JitsiConferenceEvents.JitsiConferenceEvents.html>

Jitsi separates app, signaling, conference focus, and media bridge. Its conference event surface includes `CONNECTION_INTERRUPTED`, `CONNECTION_RESTORED`, `CONFERENCE_FAILED`, `BRIDGE_BWE_STATS_RECEIVED`, `LAST_N_ENDPOINTS_CHANGED`, track added/removed/mute events, and role/moderation events.

Borrow for Chalk:

- Keep provider media bridge state distinct from app room state.
- Track adaptive forwarding state, not just local camera on/off.
- Include bridge/provider region and media path data in diagnostics.

### Google Meet

Sources:

- Google Meet API conference records/participant sessions: <https://developers.google.com/workspace/meet/api/reference/rest/v2>
- Participant/session guide: <https://developers.google.cn/meet/api/guides/participants?hl=en>
- Quality troubleshooting: <https://support.google.com/meet/answer/10620583>
- Admin network/video troubleshooting: <https://support.google.com/a/answer/7582554>
- Connection troubleshooting: <https://support.google.com/meet/answer/16565148>

Public Google Meet sources do not expose Meet's internal media architecture, but they do reveal product semantics:

- A meeting has conference records, participants, and participant sessions.
- Quality issues are diagnosed by separating sender vs receiver, device, CPU, network, bandwidth, latency, VPN/firewall, and QoS causes.
- Meet gives in-call troubleshooting suggestions and can reduce video usage to stabilize audio.

Borrow for Chalk:

- Persist participant sessions, not just participants.
- Add a quality panel/debug export that separates sender-side, receiver-side, device, network, and provider evidence.
- Prefer graceful degradation: keep audio, lower/disable video, recover screen share separately.

## Recommended Architecture

### 1. Add a Media Connection Vector

Keep `SessionConnectionState` for compatibility, but derive it from a richer internal object:

```ts
type MediaConnectionVector = {
  roomLifecycle: "joining" | "live" | "draining" | "ended";
  participantSession: "admitted" | "joining_media" | "connected" | "reconnecting" | "dropped" | "left" | "failed" | "kicked";
  controlWs: "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";
  providerSignal: "idle" | "connecting" | "connected" | "reconnecting" | "failed" | "closed";
  mediaTransport: "unknown" | "checking" | "connected" | "degraded" | "interrupted" | "recovering" | "failed";
  token: "valid" | "refreshing" | "expired" | "revoked";
  device: {
    camera: "unknown" | "ready" | "permission_denied" | "missing" | "switching" | "failed";
    microphone: "unknown" | "ready" | "permission_denied" | "missing" | "switching" | "failed";
    speaker: "unknown" | "ready" | "unsupported" | "failed";
  };
  generation: number;
  lastStableAtMs: number | null;
  lastCause?: string;
};
```

Derived public status:

- `connected` only if room is live, participant session is connected/recoverable, and at least one of WS/provider is connected with media not failed.
- `reconnecting` if any essential channel is recovering and room is not ended.
- `failed` if media/provider/control cannot recover or participant session is revoked.
- `disconnected` only for clean local leave or after terminal server state.

### 2. Make Participant Session Server-Authoritative

Backend state should distinguish:

```text
admitted -> joining_media -> connected
connected -> reconnecting -> connected
reconnecting -> dropped -> ended/left
connected -> left
connected -> kicked
```

Rules:

- API admission creates `participant_sessions` with a `room_session_id`, `participant_id`, `session_revision`, `state = admitted`.
- RTK/media active confirmation promotes to `connected`.
- WS close promotes to `reconnecting` or `dropped`, not `left`.
- Explicit SDK leave promotes to `left`.
- Kick/ban promotes to `kicked` and revokes session tokens.
- Empty-room cleanup waits for reconnect grace and checks active media/provider state.

This directly fixes the false-leave hazard.

### 3. Treat Reconnect As A Workflow

A reconnect workflow should have these phases:

1. Detect: heartbeat timeout, RTK `roomLeft`, ICE failed/disconnected, token expiring, browser offline, tab background resume.
2. Freeze user-visible identity: keep tile, name, role, permissions, and last-known tracks.
3. Mark reconnecting: local vector plus server participant session.
4. Refresh auth: access token and provider token, tied to current `room_session_id` and `participant_session_id`.
5. Recover control: reconnect WS and request revision-based sync.
6. Recover media: let RTK recover, call provider recovery primitive if available, or full RTK rejoin if threshold exceeded.
7. Reconcile: compare server participant-session revision, provider participant snapshot, RTK participants, and WS room snapshot.
8. Emit `reconnected` with cause, duration, generation, and whether media was preserved.
9. If recovery fails, emit terminal reason and keep enough diagnostics for support.

### 4. Replace Wall-Clock `lastSeq` With Durable Revisions

Current `room.sync` uses `Date.now()`. Replace with:

```ts
type RoomSyncRequest = {
  roomSessionId: string;
  lastRevision: number;
  clientProjectionHash?: string;
};
```

Server returns:

```ts
type RoomSyncResponse = { kind: "delta"; fromRevision: number; toRevision: number; events: RoomEvent[] } | { kind: "snapshot"; revision: number; snapshot: RoomSnapshot; reason: "gap" | "unknown_client" | "too_old" };
```

This aligns with Matrix's initial snapshot plus incremental sync design and Zero/Convex-style "server truth plus client projection" lessons from the earlier sync pass.

### 5. Make Tracks State Machines

Model local media commands as command/reconcile, not direct mutation:

```text
camera: off -> enabling -> on -> disabling -> off
camera: enabling -> failed(permission_denied | device_missing | provider_error)
camera: on -> interrupted(track_ended | device_removed | provider_replaced)
screen: off -> selecting -> publishing -> on -> stopping -> off
screen: selecting -> cancelled | failed
```

Each command needs:

- `commandId`
- requested state
- provider call
- provider event acknowledgement
- local timeout
- rollback behavior
- server projection if host/moderation controls are involved

### 6. Adapt Media, Do Not Force Media

The `boostVideoBitrate` helper should be removed or moved behind a debug/experiment flag. Production behavior should rely on provider/SFU adaptation where possible:

- Simulcast/SVC.
- Bandwidth estimation.
- Subscriber-side video constraints.
- Active speaker / visible tile driven subscriptions.
- Screen share separate encoding.
- Audio priority over video.
- Quality hints and "turn off video" suggestions.

### 7. Add Reconnect UX Semantics

User-visible states should be specific:

- "Reconnecting audio/video..."
- "Chat is reconnecting..."
- "You are still in the room. Trying to restore media..."
- "Network is unstable. Keeping audio; reducing video."
- "Screen sharing stopped during reconnect."
- "Rejoin required" only after terminal failure.

Avoid treating every `disconnected` as the meeting ended. In `packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts:57-80`, the disconnect grace path should be driven by terminal server state or media vector failure, not just SDK status.

## Invariants

- A transient WS close must never mark a participant as left.
- A participant can be "temporarily unreachable" without leaving the room.
- A clean leave, kick, room end, token revoke, and network drop must produce distinct terminal causes.
- `connected` means media/control state has been reconciled for the current room session generation.
- Reconnect must be idempotent. Multiple timeouts should not create duplicate participant sessions or duplicate RTK provider participants.
- Every room snapshot must include `room_session_id` and revision.
- Every media command should have one final state: succeeded, rejected, cancelled, timed out, or superseded.
- Track publication and local playable track are different states.
- Audio should degrade last.
- Debug export must be able to answer: API admitted? WS connected? RTK joined? ICE connected? provider token valid? device available? server still considers participant active?

## Phased Plan

### Phase 0: Immediate Safety

- Stop marking participant `left` on WebSocket unregister. Change to `connection_lost` or `reconnecting` with grace.
- Add SDK/server tests for WS close followed by reconnect preserving participant active state.
- Add `room.ended` handling to SDK inbound events if missing from the current path.
- Remove or feature-flag `boostVideoBitrate`.
- Add reconnect telemetry fields: cause, channel, duration, generation, token_refresh_result.

### Phase 1: State Vector

- Implement internal `MediaConnectionVector` in `ConferenceSession`.
- Emit derived public `connection.state.changed` for compatibility.
- Add `connection.vector.changed` for advanced consumers and diagnostics.
- Update React overlay logic to use vector states.

### Phase 2: Session Revisions

- Introduce `room_sessions` and `participant_sessions`.
- Include `room_session_id`, `participant_session_id`, and `revision` in tokens, WS payloads, snapshots, recordings, and provider metadata if available.
- Replace wall-clock `lastSeq` with durable revision.

### Phase 3: Reconnect Workflow

- Add reconnect coordinator in SDK.
- Add server-side participant reconnect grace.
- Add provider recovery/full-rejoin policy.
- Add state reconciliation after reconnect.

### Phase 4: Media Quality Engine

- Collect RTC stats and RTK diagnostics on intervals and transitions.
- Add quality levels and degradation actions.
- Make subscriber constraints/tile visibility feed provider settings if RTK exposes them.
- Add screen-share recovery and explicit stop-on-reconnect semantics.

## Test Plan

### SDK Unit Tests

- WS heartbeat timeout enters `reconnecting`, refreshes token, reconnects, requests sync with revision.
- RTK `roomLeft({ state: "disconnected" })` enters media reconnecting, not terminal disconnected.
- RTK `roomLeft({ state: "failed" })` emits terminal failed with cause.
- `roomJoined` after reconnect emits `reconnected` and reconciles stale remote participants.
- Camera toggle command handles provider success, provider failure, timeout, and late contradictory provider event.
- Screen share cancel does not produce a fatal meeting error.
- Device switch failure rolls back previous enabled state.

### Backend Integration Tests

- WS disconnect does not call `LeaveRoom`.
- Reconnect inside grace preserves participant session.
- Reconnect after grace returns a clear "session dropped, rejoin required" response.
- Kick revokes WS reconnect and provider token refresh.
- Empty-room cleanup ignores reconnecting participants until grace expires.

### Browser / E2E Tests

- Join two clients, drop WS for one client, restore, verify roster never flickers to left.
- Drop network for 5/20/60 seconds and verify correct reconnect or terminal state.
- Expire access token during reconnect and verify token refresh path.
- Switch Wi-Fi to LTE or offline/online in mobile simulator.
- Remove camera/mic permissions mid-call.
- Unplug camera/mic during active call.
- Start screen share, drop network, verify expected screen-share state after recovery.
- Simulate low bandwidth and verify video degradation before meeting failure.

### Chaos / Soak

- 50 rooms with random WS drops, RTK join delays, token refresh delays, and provider webhook delay.
- Long meeting with repeated network changes and device changes.
- Multi-instance WS deployment with Redis pub/sub delay and snapshot fallback.

## Open Questions

- Does Cloudflare RealtimeKit expose explicit ICE restart, transport state, participant reconnecting, and connection quality events? If yes, wrap them. If no, treat RTK as a black-box provider and build Chalk's state vector around observable RTK events plus browser RTC stats.
- Can provider metadata include `room_session_id` and `participant_session_id` for reconciliation?
- Should Chalk attempt full RTK rejoin automatically after provider reconnect timeout, or prompt the user?
- What is the desired product behavior for screen share during media reconnect: preserve, stop, or prompt?
- Should participant audio continue while video reconnects, and can RTK expose enough state to distinguish that?

## Bottom Line

Chalk should not try to make "connected" more clever. It should make "connected" a derived convenience over explicit, inspectable state machines. The robust system is: durable participant sessions on the server, explicit client media/control vectors, revisioned sync after reconnect, and user-visible recovery that preserves room identity while the transports heal.
