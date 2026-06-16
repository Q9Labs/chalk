# SDK State Machines Deep Dive

Date: 2026-05-30

Scope: Chalk SDK state correctness, `ConferenceSession`, `ChalkSession`, Effect services, WebSocket client, RTK event bridges, React hooks, local managers, and production lessons from LiveKit, Twilio Video, AWS Chime SDK, Matrix, Jitsi, Convex, Zero, and public Google Meet docs.

## Executive Summary

Chalk already has several implicit state machines:

- `WSClientBase` has a real connection/reconnect machine.
- `RoomService` has a join/connected/failed/leave machine.
- `ConferenceSession` has RTK and WS event bridges.
- React `VideoConference` has lobby/joining/meeting/end phases.
- Managers hold media, participants, recording, whiteboard, chat, and UI projections.

The problem is that these machines are not one explicit system. They are connected by event emitters, optimistic local mutation, one-time snapshots, and some corrective guards. That is why small discrepancies can become meeting-visible: one layer thinks it is connected, another thinks it is disconnected, another has cleared runtime state, and another still has tiles on screen.

The target architecture is not "one giant reducer." It is a small set of explicit, composable statecharts:

- Session lifecycle: uninitialized, idle, joining, live, reconnecting, leaving, ended, failed, disposed.
- Control channel: disconnected, connecting, connected, reconnecting, failed, closed.
- Media provider: initializing, joining, joined, reconnecting, rejoined, failed, left.
- Participant projection: snapshot pending, synced, stale, gap, reconciling.
- Local command machines: camera, microphone, screen share, display name, hand, chat send, whiteboard.
- Authorization/capability snapshot: unknown, current, stale, revoked.
- React view phase: lobby, joining, meeting, recovering, end.

Production systems repeatedly show the same lesson:

- LiveKit and Twilio expose reconnection and participant events as first-class API, not incidental errors.
- AWS Chime separates lifecycle condition, observer callbacks, metrics, and stop reasons.
- Matrix's `/sync` API separates initial state, incremental deltas, `next_batch`, and limited/gap behavior.
- Zero and Convex-style sync engines treat client views as projections of server truth, with explicit invalidation/reconciliation.
- Google Meet exposes participant sessions and user-facing quality/recovery flows.

Chalk should make state transitions typed, causeful, generation-bound, and testable. The SDK can remain ergonomic, but internally it should reject impossible transitions, ignore late events from old generations, and always be able to explain what it believes and why.

## Current Chalk State Machines

Line numbers refer to the local working tree on 2026-05-30.

### `WSClientBase`

`packages/sdk-core/src/ws-client/base.ts` owns a compact WebSocket state machine:

- Internal state starts as `disconnected` (`base.ts:23`).
- `connect()` is ignored if already connected/connecting (`base.ts:87-100`; decision in `connection-controller.ts:33-35`).
- `onopen` transitions to connected, resets reconnect attempt, starts heartbeat, emits `connected`, and requests `room.sync` after reconnect (`base.ts:141-156`).
- `onclose` emits disconnected if already cleanly disconnected, otherwise schedules reconnect (`base.ts:159-195`).
- Reconnect decisions move through `reconnecting`, `failed`, or no-op (`connection-controller.ts:45-70`).
- Token refresh happens before reconnect (`base.ts:338-365`).
- `disconnect()` forces `disconnected`, clears timers, and closes socket (`base.ts:416-430` in the local file).

Strengths:

- Simple, testable, and has heartbeat/retry/token refresh.
- The state list is explicit.
- The reconnect schedule is bounded.

Weaknesses:

- It has no `reconnected` event distinct from `connected`.
- It cannot prove room event continuity because `room.sync` uses wall-clock `lastSeq`.
- It cannot distinguish server policy close, room ended, token revoked, network close, or deploy restart as durable causes.
- Its state is separate from RTK/media state and can be overwritten by `ConferenceSession` bridges.

### `ConferenceSession`

`packages/sdk-core/src/room.ts` is the central SDK object.

Relevant state:

- `_connectionState` starts as `disconnected` (`room.ts:40`).
- Participants, peer-id map, local participant, active speaker, messages, transcripts, recording, tokens, whiteboard permissions, room-created flag, tenant config, and room-sync-ready flag are private fields (`room.ts:40-55`).
- RTK and WS clients are optional and can both be attached (`room.ts:56-62`).
- `leaveState` prevents duplicate leave calls (`room.ts:63-66`).
- Constructor wires managers and optionally attaches either WS or RTK listeners (`room.ts:75-173`).
- `_setConnectionState` emits `connection.state.changed` only on value change (`room.ts:339-343`).
- `attachWsClient` swaps WS listener wiring (`room.ts:371-377`).
- `clearRuntimeState` unsubscribes WS signaling and clears store state (`room.ts:261-265`).

Strengths:

- The public object is cohesive and ergonomic.
- It centralizes local participant and room event emission.
- It has enough fields to become a real statechart host.

Weaknesses:

- There is no generation/session epoch. Late events from an old WS/RTK object can still call closures unless cleanup happened perfectly.
- "Connected" is set by several sources: RTK join seed during construction, RTK `roomJoined`, WS connected if no RTK, and WS snapshot if RTK exists (`join-session.ts:124-127`, `rtk-participants.ts:158-168`, `ws-signaling.ts:35-39`, `ws-signaling.ts:188-205`).
- There is no `destroyed` or `disposed` terminal guard on `ConferenceSession` itself.
- Store mutations are direct and imperative. There is no reducer rejecting out-of-order transitions.

### RTK Signaling Bridge

`packages/sdk-core/src/conference-session/rtk-participants.ts` adapts provider events:

- `roomJoined` sets connected, syncs local media, reconciles joined participants, prunes stale remotes, reapplies background effect (`rtk-participants.ts:158-168`).
- `roomLeft` maps intentional leave to disconnected, provider failure to failed, and other leaves to reconnecting (`rtk-participants.ts:170-195`).
- Local media updates mutate local participant and emit `participant.updated` (`rtk-participants.ts:197-310`).
- Remote participant join/left/update events create/delete/mutate participants (`rtk-participants.ts:314-360` and later handlers).

Weaknesses:

- Provider participant-left and network reconnect are not separated at the Chalk participant projection level.
- RTK state has no generation. A reconnect can swap tracks and participants without recording why.
- Media update order is provider order only; there is no command ID or client/server revision.

### WS Signaling Bridge

`packages/sdk-core/src/conference-session/ws-signaling.ts` adapts Chalk WS events:

- WS connection events update session state only when there is no RTK client (`ws-signaling.ts:35-51`).
- If RTK exists, WS participant join/leave/update events are ignored (`ws-signaling.ts:53-84`).
- Participant mute/unmute commands are applied to local RTK audio (`ws-signaling.ts:86-92`).
- Chat, reactions, hand raise/lower, recording, whiteboard, and permission events mutate local state and emit SDK events (`ws-signaling.ts:94-280`).
- `room.snapshot` can set RTK-backed sessions to connected and hydrate recording (`ws-signaling.ts:188-205`).

Strengths:

- It intentionally prevents double participant projection when RTK is present.
- It makes chat/whiteboard/recording available through the same `ConferenceSession`.

Weaknesses:

- No snapshot revision/gap handling.
- `room.snapshot` has authority to promote connected, which can mask RTK/media failure.
- There is no formal priority rule for conflicts between RTK participant projection and WS snapshot data.
- `room.ended` is not handled in the shown inbound handlers list from the lifecycle report.

### `ChalkSession`

`packages/sdk-core/src/session/chalk-session.ts` wraps `ConferenceClient`, managers, and Effect services.

Relevant state:

- `_currentRoom`, bridge cleanup, external subscriptions, connected input room ID, in-flight join room ID/promise, and disposed flag (`chalk-session.ts:140-150`).
- Event forwarding is torn down and recreated, forwarding room connected/disconnected/status/error and manager errors (`chalk-session.ts:273-337`).
- `join()` dedupes same-room in-flight join and returns if already connected to the same input room (`chalk-session.ts:393-459`).
- `joinWithJoinToken` and `joinWithInviteLink` do similar work but do not share the same dedupe wrapper (`chalk-session.ts:462-546`).
- `leave()` runs `RoomService.leave`, disconnects the client, clears bridge/current-room/in-flight state, and resets session state (`chalk-session.ts:553-570`).
- `recoverStaleConnectedRoomState` resets if state says connected but no room object exists (`chalk-session.ts:367-385`).

Strengths:

- In-flight join dedupe exists.
- It detects a stale connected state shape.
- It centralizes managers.

Weaknesses:

- `disposed` appears in diagnostics but is not a universal transition guard around async join/leave paths.
- `joinWithJoinToken` and `joinWithInviteLink` do not obviously share `inFlightJoinPromise` dedupe.
- Joining a new room first leaves the current session in `ConferenceClient.joinSession` (`packages/sdk-core/src/client.ts:188-193`), while `ChalkSession.join` separately drives RoomService. These are coupled but not one transaction.
- Manager attach/bridge errors are swallowed with comments (`chalk-session-bridges.ts:60-78`). The user can have a room joined but partial manager state.

### Effect `RoomService`

`packages/sdk-core/src/effect/services/room-service.ts` has a formal-ish state service:

- Initial state is `disconnected`, `roomId: null`, `isJoining: false` (`room-service.ts:34-41`).
- `requestJoin` rejects if joining or connected, then sets `isJoining: true` and `status: connecting` (`room-service.ts:127-159`).
- `joinComplete` stores the room, sets up listeners, sets state connected, and publishes `Connected` (`room-service.ts:161-179`).
- `joinFailed` sets `isJoining: false` and `status: failed` (`room-service.ts:181-189`).
- `leave` cleans up listeners, calls `room.leave()`, clears room ref, resets initial state, and publishes disconnected (`room-service.ts:191-229`).

Strengths:

- This is the closest thing to a state machine in the SDK.
- It uses a semaphore and typed events.

Weaknesses:

- The service is not the only owner of state. `ConferenceSession`, managers, React, and `ConferenceClient` all own related state.
- It does not represent `reconnecting`, `ending`, `ended`, `disposed`, or room-session generation as explicit flows.
- `joinFailed` always maps to a room-not-found shaped error in `ChalkSession.join` even when the actual failure was RTK/media/token/network (`chalk-session.ts:426-438`).

### React View State

`packages/sdk-react/src/components/full/video-conference` layers view phases over SDK state:

- `useJoinFlow` has `JOIN_RETRY_DELAYS_MS = [500, 1200]`, `joinInFlightRef`, and retries transient join failures (`useJoinFlow.ts:13`, `useJoinFlow.ts:74-83`, `useJoinFlow.ts:118-226`).
- It sets phase to `meeting` immediately after `join()` returns, then runs post-join device tasks asynchronously (`useJoinFlow.ts:146-177`).
- `useConferenceLifecycleState` maintains disconnect grace state and timers (`useConferenceLifecycleState.ts:23-80`).
- `useSessionEvents` listens for `disconnected` and after grace moves to end if latest status is `disconnected` or `failed` (`useSessionEvents.ts:57-80`).
- `useConferenceConnectionState` maps SDK status and phase to UI connection state (`useConferenceConnectionState.ts:17-39`).

Strengths:

- The view gives users grace during transient disconnects.
- Join retries are bounded and have telemetry breadcrumbs.

Weaknesses:

- React phase is another state machine parallel to the SDK. It can decide the meeting ended based on an SDK status that may have been produced by a recoverable transport.
- `onJoin` uses `localParticipant` from React state immediately after join; that state can lag the actual joined room (`useJoinFlow.ts:169-176`).
- The UI has no access to a detailed vector, so it cannot distinguish chat reconnect, media reconnect, token refresh, room ended, kick, or provider failure.

## Key Risks

| Severity | Risk                                                             | Evidence                                                                                                                  | Impact                                                                                                       |
| -------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Critical | Multiple owners can disagree on session status.                  | `ConferenceSession`, `RoomService`, `WSClientBase`, React phase, and managers all hold related state.                     | UI can show connected while media is failed, or end meeting during recoverable reconnect.                    |
| Critical | No generation guard for late async events.                       | `ConferenceSession` has no session generation/disposed transition guard; RTK/WS closures mutate state directly.           | Old reconnect or old room events can mutate a new room/session.                                              |
| High     | Snapshot sync cannot prove continuity.                           | WS reconnect sends wall-clock `lastSeq` (`base.ts:151-156`).                                                              | Missed events after reconnect can go undetected.                                                             |
| High     | Join is admitted before all runtime bridges are healthy.         | API join precedes RTK and WS; manager bridge attach errors are swallowed (`chalk-session-bridges.ts:60-78`).              | Partial joins can become active participants with broken local state.                                        |
| High     | State transitions lack causes.                                   | Public `SessionConnectionState` is just strings.                                                                          | Support and product cannot distinguish leave, kick, room end, token, media, WS, provider, or device failure. |
| Medium   | Local commands are optimistic and not command-ID based.          | Media toggles and display name mutate local participant after API/provider call (`media-controls.ts`, `room.ts:515-532`). | Late provider/server events can overwrite or duplicate local state.                                          |
| Medium   | React view phase can reinterpret recoverable states as terminal. | Disconnect grace checks only `disconnected` or `failed` after a timer (`useSessionEvents.ts:65-75`).                      | Bad user experience during network churn.                                                                    |

## Production Systems To Learn From

### LiveKit

Sources:

- Room events: <https://docs.livekit.io/reference/client-sdk-js/enums/RoomEvent.html>
- Track management: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/tracks/>
- Advanced media: <https://docs.livekit.io/transport/media/advanced/>

LiveKit gives applications many specific events: reconnecting, reconnected, connection-state changed, connection quality changed, participant connected/disconnected, track published/subscribed/unsubscribed, device errors, recording status, and permissions changes. Its track docs separate a published track from a subscribed/available track.

SDK lesson:

- Public ergonomics can stay simple, but internal event taxonomy must be rich.
- Track state, participant state, and room state are related but not the same machine.

### Twilio Video

Source: <https://www.twilio.com/docs/video/reconnection-states-and-events>

Twilio exposes `Room.state`, room `reconnecting`/`reconnected`, remote participant reconnecting/reconnected, terminal disconnected, and token-expiry reconnection failure. It distinguishes signaling and media reconnect causes.

SDK lesson:

- `reconnecting` needs a cause and a reconnected counterpart.
- Remote participants need their own reconnecting state.
- Token lifecycle belongs in the connection state machine.

### AWS Chime SDK

Sources:

- Lifecycle event conditions: <https://aws.github.io/amazon-chime-sdk-js/enums/meetingsessionlifecycleeventcondition.html>
- AudioVideoObserver: <https://aws.github.io/amazon-chime-sdk-js/interfaces/audiovideoobserver.html>

Chime distinguishes new connection, reconnecting existing session, started after reconnect, clean stop, and failure stop. Its observer reports connection health, poor/good transitions, suggested video stop, metrics, and video availability.

SDK lesson:

- State transitions should be analytics-grade and stable.
- "Poor connection" is not failure. It is an actionable state.

### Matrix

Source: <https://spec.matrix.org/latest/client-server-api/>

Matrix's `/sync` model separates initial sync from incremental sync. Clients get a `next_batch` token and use it as `since` for the next call. When an incremental sync is limited, state deltas have specific meaning and clients must handle gaps.

SDK lesson:

- `room.sync` should be cursor/revision based, not timestamp based.
- The client projection needs "synced", "stale", "gap detected", and "snapshot applied" states.
- Event application should be deterministic and replayable in tests.

### Zero and Convex

Sources:

- Zero status/docs: <https://zero.rocicorp.dev/docs/status>
- Zero ZQL docs: <https://zero.rocicorp.dev/docs/zql>
- Convex realtime docs: <https://docs.convex.dev/realtime>
- Convex sync overview: <https://www.convex.dev/sync>

Zero and Convex are not video SDKs, but their core lesson applies: the UI should be a projection of a consistent server view, and client state must know when it is optimistic, synced, stale, or invalidated. Earlier Chalk sync docs cover this more deeply.

SDK lesson:

- Chat, whiteboard, participant list, permissions, and recording should be projections with revisions.
- Optimistic commands should be labeled and reconciled.
- The SDK should avoid hidden side effects that cannot be replayed.

### Jitsi

Sources:

- Architecture: <https://jitsi.github.io/handbook/docs/architecture>
- Conference events: <https://jitsi.github.io/lib-jitsi-meet/enums/JitsiConferenceEvents.JitsiConferenceEvents.html>

Jitsi exposes a broad conference event API including join progress, connection interrupted/restored, conference failed, bridge bandwidth stats, data channel state, track events, dominant speaker, role changes, recorder state, lobby, and moderation.

SDK lesson:

- A serious meeting SDK has many event types because production meetings have many independent failure domains.
- The app can present a simple UI, but the SDK should retain precise event causes.

### Google Meet

Sources:

- Meet API REST resources: <https://developers.google.com/workspace/meet/api/reference/rest/v2>
- Participant/session guide: <https://developers.google.cn/meet/api/guides/participants?hl=en>
- Quality troubleshooting: <https://support.google.com/meet/answer/10620583>
- Host controls: <https://support.google.com/meet/answer/16229038>

Public Meet docs show conference records, participants, participant sessions, host controls, and quality troubleshooting that separates network, device, CPU, VPN/firewall, sender, and receiver causes.

SDK lesson:

- "Participant" and "participant session" should not be conflated.
- Quality/debug surfaces should be structured enough that support can localize the failure domain.

## Recommended Statechart Architecture

### 1. Session Lifecycle

```text
uninitialized
  -> idle
  -> joining
  -> live
  -> reconnecting
  -> live
  -> leaving
  -> ended

joining -> failed
live -> failed
reconnecting -> failed
any -> disposed
```

Each transition should carry:

- `from`
- `to`
- `cause`
- `roomSessionId`
- `participantSessionId`
- `generation`
- `at`
- optional `error`

Forbidden:

- `disposed -> anything`
- old generation event mutating current generation
- `ended -> live` without a new room session generation
- `failed -> connected` without explicit retry/new generation

### 2. Connection Vector

Internal SDK state should contain:

```ts
type ConnectionVector = {
  session: SessionLifecycleState;
  controlWs: ControlChannelState;
  mediaProvider: MediaProviderState;
  mediaTransport: MediaTransportState;
  sync: ProjectionSyncState;
  auth: AuthState;
  capabilities: CapabilitySnapshotState;
  devices: DeviceState;
};
```

`SessionConnectionState` stays as a derived public field:

```ts
function derivePublicStatus(vector: ConnectionVector): SessionConnectionState {
  if (vector.session === "failed" || vector.mediaProvider === "failed") return "failed";
  if (vector.session === "leaving" || vector.session === "ended") return "disconnected";
  if (vector.session === "joining") return "connecting";
  if (vector.session === "reconnecting" || vector.controlWs === "reconnecting" || vector.mediaProvider === "reconnecting" || vector.sync === "stale") return "reconnecting";
  if (vector.session === "live") return "connected";
  return "disconnected";
}
```

### 3. Projection Store

Participant/chat/whiteboard/recording/permissions state should be applied through reducers:

```ts
type ProjectionState<T> = {
  status: "empty" | "loading" | "synced" | "stale" | "gap" | "reconciling" | "failed";
  roomSessionId: string;
  revision: number;
  value: T;
};
```

Rules:

- Drop events from old `roomSessionId`.
- Drop or quarantine events with revision <= current revision unless explicitly idempotent.
- If revision jumps and no delta is available, enter `gap` and request snapshot.
- Snapshot replaces value only if snapshot revision >= current revision.
- Every reducer is pure and tested with replay.

### 4. Command Machines

Every user action that leaves the browser should be command-based:

```ts
type LocalCommand<T> = {
  commandId: string;
  kind: string;
  target: string;
  requested: T;
  state: "pending" | "sent" | "acknowledged" | "reconciled" | "rejected" | "timed_out" | "superseded";
  generation: number;
};
```

Applies to:

- camera toggle
- microphone toggle
- screen share start/stop
- display name update
- hand raise/lower
- mute/unmute participant
- recording start/stop
- whiteboard permission grant/revoke
- chat send/read receipt

This prevents "optimistic local mutation forever" and gives support a precise command timeline.

### 5. Generations

Add a local `sessionGeneration` that increments for every join/rejoin/dispose boundary. Every listener closure captures the generation:

```ts
const generation = this.generation;
rtk.self.on("roomJoined", () => {
  if (generation !== this.generation) return;
  this.transition(...);
});
```

This is the simple guard that prevents old events from contaminating new sessions.

### 6. Dispose Discipline

Add a terminal `disposed` state:

- `ChalkSession.dispose()` sets disposed before async cleanup.
- Public methods reject after disposed.
- Async join/leave callbacks check disposed before mutation.
- All managers support `attachRoom(null)` or `detach()`.
- Tests assert no events fire after dispose.

### 7. React As A Projection Consumer

React should not reinterpret low-level transport states on its own. It should consume:

- public status
- connection vector summary
- terminal reason
- recovery action
- support/debug code

Recommended view phases:

```text
lobby -> joining -> meeting -> recovering -> meeting
joining -> lobby_error
meeting -> leaving -> end
recovering -> end | lobby_error
```

`recovering` is distinct from `end`.

## Invariants

- Exactly one current room session generation can mutate SDK state.
- Clean leave, room end, kick, token revoke, network reconnect, media failure, and SDK dispose are distinct causes.
- A public `connected` state requires current generation, live session, and no known sync gap.
- WS reconnect alone cannot mark the meeting ended.
- Provider reconnect alone cannot clear chat/whiteboard state.
- A snapshot cannot overwrite newer local projection state.
- Optimistic commands must either reconcile or reach a terminal command state.
- UI phase is downstream of SDK state, not an independent source of truth.
- No event should be emitted after dispose.
- Debug snapshots must include generation, room session, participant session, vector state, revisions, and pending commands.

## Phased Plan

### Phase 0: Map and Guard

- Add `sessionGeneration` to `ConferenceSession` and `ChalkSession`.
- Add generation checks to RTK and WS listener closures.
- Add `disposed` guards around join/leave and public methods.
- Add `reconnected` event alongside existing `connection.state.changed`.
- Add transition cause to internal telemetry without changing public API.

### Phase 1: Vector Behind Existing API

- Add internal `ConnectionVector`.
- Derive existing `status` from vector.
- Update debug export to show vector.
- Teach React overlays to use vector summary and terminal reason.

### Phase 2: Revisioned Projection

- Replace `lastSeq` timestamp sync with room-session revision.
- Add projection reducers for participants, recording, chat, permissions, and whiteboard.
- Add gap/snapshot states and tests.

### Phase 3: Command Registry

- Add command IDs and pending command registry.
- Convert media toggles, screen share, display name, recording, and moderation commands.
- Add timeout, rejection, and superseded semantics.

### Phase 4: Statechart Tests and Tooling

- Add model tests for legal/illegal transitions.
- Add replay tests for out-of-order provider/WS events.
- Add debug timeline export.
- Add chaos tests for network changes, token refresh, room end, kick, and duplicate joins.

## Test Plan

### Unit Tests

- `disposed` ignores late RTK `roomJoined`.
- Old generation WS snapshot is dropped.
- New generation can join after old generation failed.
- `reconnecting -> connected` emits `reconnected`.
- `failed -> connected` is rejected unless retry starts a new generation.
- Snapshot older than current revision is ignored.
- Revision gap enters `gap` and requests snapshot.
- Command timeout emits terminal command failure.

### Integration Tests

- API join succeeds, RTK fails, SDK reports join failure and backend participant is cleaned or marked aborted.
- WS reconnect during active RTK media does not clear participants.
- RTK reconnect during active WS does not mark room ended.
- Room end from server moves SDK to terminal ended and blocks reconnect.
- Kick moves SDK to terminal kicked/revoked and closes WS.
- Token refresh failure during reconnect gives auth-specific failure.

### React Tests

- Meeting moves to recovering, not end, on recoverable disconnect.
- Recovered meeting returns to meeting phase without losing participants.
- Terminal room end moves to end immediately.
- Terminal kick/revoke shows appropriate action.
- `onJoin` receives participant ID after state bridge has local participant.

### Property / Model Tests

- Generate random event sequences across WS, RTK, API, and React timers.
- Assert invariants: no events after dispose, no stale generation mutation, no connected with sync gap, no duplicate local participant, no negative participant count.

## Open Questions

- Should `ConferenceSession` be the only statechart host, or should `ChalkSession` own the root machine and `ConferenceSession` become a transport/projection adapter?
- How much of the vector should be public API in v1 vs hidden diagnostics?
- Can Cloudflare RealtimeKit expose stable event causes and transport stats, or do we need browser `getStats()` plus black-box provider states?
- Should command reconciliation require backend revisions for all commands, or only room-control commands?
- How should mobile background/foreground be represented: reconnect cause, lifecycle pause, or separate app-state vector?

## Bottom Line

The SDK should become boring in the best way: explicit states, explicit causes, explicit generations, revisioned projections, and command reconciliation. The public API can still feel simple. Underneath, every event should answer: "Which session generation is this for, what fact changed, who is authoritative, and is the UI projection now current?"
