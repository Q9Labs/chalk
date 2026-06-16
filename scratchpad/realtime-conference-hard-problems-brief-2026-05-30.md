# Realtime Conference Hard Problems Brief

Date: 2026-05-30

This short brief was rewritten with `gemini-3.1-pro-preview` from the four deeper Chalk research notes on meeting lifecycle, WebRTC/media reconnect, permissions/trust, and SDK state machines.

## The Big Picture

Chalk has proven the core realtime experience, but to scale reliably the architecture needs to separate concepts that are currently compressed together. Today, transient network drops can look like intentional participant leaves, UI state can drift from actual media transport health, and some permission decisions are too dependent on client-supplied role strings or stale JWT booleans.

In a production video room, "connected" is not one boolean. A participant can have a valid access token, a dead WebSocket, a reconnecting media transport, stale permissions, and a disabled camera at the same time. When these layers do not have explicit state machines, small discrepancies become visible meeting failures: ghost participants, false room endings, duplicate joins, missed moderation updates, and confusing recovery UI.

The direction is clear: make Postgres the source of lifecycle intent, model client state as projections of durable server state, add explicit participant sessions and room sessions, and treat reconnect, permissions, media health, and SDK lifecycle as first-class systems.

## The Four Systems We Need To Harden

### 1. Meeting Lifecycle and Room Control

Chalk currently overloads the idea of a "room." A single room row can represent the reusable room, the active provider meeting, the participant roster, the recording session, and meeting history. That makes transitions fragile. If every participant's WebSocket drops for a moment, the system can see zero active participants and end a room that clients are still trying to recover.

Provider state is also created outside clear database transition boundaries. A scheduled room can create a Cloudflare meeting long before the room becomes active. An ended room can be reactivated under the same `room_id` without a clean session epoch. Recording has similar issues: no durable `starting` or `stopping` state, no active-recording uniqueness guard, and provider/webhook events that can arrive late or duplicate.

### 2. Media and Reconnection

The SDK joins the API first, then joins RealtimeKit media, then connects Chalk WebSocket sync. If API admission succeeds but media join fails, the backend can still think the participant is active.

The highest-risk issue is reconnect misclassification. The client treats WebSocket closure and RTK `roomLeft` as recoverable reconnect states. The server side has paths that treat WebSocket closure as a participant leave. That mismatch causes false leaves, roster churn, empty-room cleanup hazards, and possible meeting termination during normal network changes.

Chalk needs an internal media connection vector that separately tracks room lifecycle, participant session, WebSocket control state, provider signaling, media transport, token health, and device health. The public SDK can still expose simple states like `connected` and `reconnecting`, but those states should be derived from a richer internal model.

### 3. Permissions, Trust, and Moderation

Chalk should move from role strings and JWT booleans toward server-authoritative capabilities. The most urgent gap is public join escalation: public join-token users can likely request `role: "host"` during join and receive host capabilities. A public invite should produce at most the role and capabilities encoded in the signed invite, defaulting to participant/viewer.

Kick and revoke are also too soft. Removing a participant from the media provider is not the same as revoking their Chalk WebSocket/control-plane access. If the WebSocket handshake only trusts a still-valid JWT, a kicked participant can retain non-media signaling access until expiry.

Whiteboard permissions are another warning sign. A SQL table exists, but live grant/revoke enforcement is mostly in-memory. In multi-instance deployments, one node can enforce a different permission state from another.

### 4. SDK State Machines

The SDK has several implicit state machines: WebSocket reconnect, `ConferenceSession`, `RoomService`, managers, and React view phases. They communicate through event emitters, optimistic mutations, and snapshots. That works until events arrive late, reconnect overlaps with leave, or a manager attaches partially.

The SDK needs explicit statecharts with generations. A callback from generation 3 must not mutate generation 4. A snapshot older than the current revision must not overwrite newer projection state. A disposed session must not emit late events. Optimistic commands like camera toggle, screen share start, recording start, and whiteboard grant need command IDs and final states: reconciled, rejected, timed out, cancelled, or superseded.

## What Production Systems Teach Us

LiveKit and Twilio Video treat reconnect as a first-class API surface, not an incidental error. They distinguish signaling reconnects, media reconnects, remote participant reconnects, terminal disconnects, connection quality, track publications, and device/media events.

AWS Chime SDK separates lifecycle conditions like connecting-new, reconnecting-existing, started-after-reconnect, stopped-cleanly, and stopped-with-failure. It also exposes poor connection, good connection, metrics, and "suggest stop video" style recovery paths.

Jitsi separates app state, signaling focus, and media bridge responsibilities. Its event surface includes connection interrupted/restored, conference failed, bridge bandwidth stats, track events, recorder state, lobby, and moderation. The lesson is not to copy Jitsi's exact architecture, but to avoid confusing media bridge state with room control state.

Matrix, Zero, and Convex teach the sync side. Matrix uses explicit sync cursors and gap-aware incremental state. Zero and Convex treat client views as projections of server truth with invalidation and reconciliation. Chalk should stop using wall-clock timestamps as sync cursors and move to durable room-session revisions.

Google Meet public docs and APIs show useful product-level boundaries. Meet exposes conference records, participants, and participant sessions. Its public troubleshooting docs separate sender, receiver, device, CPU, network, bandwidth, VPN/firewall, and admin-quality-tool causes. We should not claim access to private Meet internals, but the public model strongly supports separating stable spaces from meeting instances and participant identity from participant sessions.

## Architecture We Should Move Toward

Postgres should own lifecycle intent and monotonic revisions. Cloudflare, Redis, WebSockets, and SDK state should be projections or side-effect targets.

Recommended identity stack:

- `room`: stable logical room or space.
- `room_session`: one revisioned meeting instance.
- `participant`: stable tenant/user identity.
- `participant_session`: one join/reconnect/leave lifecycle inside a room session.
- `room_control_events`: durable moderation and policy events.
- `room_policy_state`: materialized capability state for authorization.

Every token, WebSocket message, snapshot, recording, and provider correlation should carry `room_session_id`, `participant_session_id` when relevant, and a monotonic revision or generation.

On the client, `SessionConnectionState` can remain as the simple public API, but internally it should be derived from a connection vector. React should consume this vector summary instead of independently deciding that a meeting ended because one transport briefly disconnected.

## Highest-Risk Fixes First

1. Patch public join escalation. Ignore client-supplied host roles unless the caller is authorized to grant that role.

2. Stop treating WebSocket close as leave. Mark participant sessions as reconnecting/dropped with a grace period, then finalize leave only after grace expires or explicit leave arrives.

3. Add hard revocation. Kick, ban, room end, and role downgrade must invalidate participant sessions and close active WebSockets across instances.

4. Add `room_sessions` and `participant_sessions`. This is the backbone for lifecycle, reconnect, recording, cleanup, and debugging.

5. Replace timestamp `lastSeq` with durable room-session revisions. Reconnect should request deltas by revision or receive a snapshot with a clear gap reason.

6. Move whiteboard and moderation permissions out of local memory and into durable room-control events plus materialized policy state.

7. Add SDK generations and disposed guards. Late RTK/WS events from old generations must be ignored.

## Operating Principles

- Transitions need causes. `failed` is not enough. Emit why: token expired, kicked, media failed, signaling timeout, room ended, device revoked, provider reconnect exhausted.
- Clients propose, servers decide. SDK permission state is a UI hint, never authorization.
- Use revisions for state and timestamps for analytics.
- Reconnect is a workflow, not a spinner.
- A poor connection is actionable state, not a terminal error.
- Preserve audio before video. Degrade gracefully before disconnecting.
- Every optimistic command needs an ID and a final reconciled state.
- Debug exports should answer: API admitted, WS connected, media joined, ICE healthy, token valid, device available, server still considers participant active.

## Source Notes

Deep-dive files:

- `scratchpad/meeting-lifecycle-control-plane-deep-dive-2026-05-30.md`
- `scratchpad/webrtc-media-reconnect-deep-dive-2026-05-30.md`
- `scratchpad/permissions-trust-moderation-deep-dive-2026-05-30.md`
- `scratchpad/sdk-state-machines-deep-dive-2026-05-30.md`

External references used across the research:

- LiveKit docs: <https://docs.livekit.io/reference/client-sdk-js/enums/RoomEvent.html>, <https://docs.livekit.io/transport/media/advanced/>
- Twilio Video reconnect docs: <https://www.twilio.com/docs/video/reconnection-states-and-events>
- AWS Chime SDK lifecycle/observer docs: <https://aws.github.io/amazon-chime-sdk-js/enums/meetingsessionlifecycleeventcondition.html>, <https://aws.github.io/amazon-chime-sdk-js/interfaces/audiovideoobserver.html>
- Jitsi architecture/events: <https://jitsi.github.io/handbook/docs/architecture>, <https://jitsi.github.io/lib-jitsi-meet/enums/JitsiConferenceEvents.JitsiConferenceEvents.html>
- mediasoup API: <https://mediasoup.org/documentation/v3/mediasoup/api/>
- Matrix Client-Server API: <https://spec.matrix.org/latest/client-server-api/>
- Zero docs: <https://zero.rocicorp.dev/docs/status>
- Convex realtime/sync docs: <https://docs.convex.dev/realtime>, <https://www.convex.dev/sync>
- Google Meet API/help docs: <https://developers.google.com/workspace/meet/api/reference/rest/v2>, <https://developers.google.cn/meet/api/guides/participants?hl=en>, <https://support.google.com/meet/answer/10620583>, <https://support.google.com/meet/answer/16229038>
