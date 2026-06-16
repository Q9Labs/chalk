# Meeting Lifecycle / Room Control Plane Deep Dive

Date: 2026-05-30
Scope: Chalk API, SDK, WebSocket presence, room cleanup, recording lifecycle, and production lessons from LiveKit, Jitsi/Jicofo, BigBlueButton, Twilio Video, AWS Chime SDK, and public Google Meet APIs.

## Executive Summary

Chalk's current room model is workable for a thin demo/control surface, but it collapses several production concepts into one `rooms` row: the reusable room/name, the active provider meeting, the participant roster, the recording session, and post-meeting history. That creates unclear transition boundaries around reconnect, room end, empty cleanup, recording, and reuse.

The highest-value architecture change is to introduce a first-class `room_sessions` control-plane entity with a monotonic `revision`, plus participant-session and recording-session state machines attached to that session. Postgres should own lifecycle intent and revisions; Cloudflare RealtimeKit, Redis, hub memory, and WebSocket payloads should become projections or side-effect targets.

The most dangerous current race is reconnect vs leave. The API marks participants active on join before the media join succeeds, then the WebSocket hub marks them left on any socket close. The SDK automatically reconnects WebSocket and RTK, so transient network churn can produce false leaves, duplicate joins, empty-room cleanup, and stale snapshots.

Recording needs the same control-plane treatment. Today start calls Cloudflare before creating the DB row, active-recording checks are non-atomic, `StopRecording` ignores Cloudflare errors, and room ending clears room state after a best-effort stop. Add `starting/stopping` states, a partial unique index for active recording, and a provider-event dedupe table.

LiveKit, Jitsi, BBB, Twilio, AWS Chime, and Google Meet converge on the same lesson: treat a meeting as an explicit lifecycle with grace periods, separate participant connection/session history from user identity, emit ordered events, and reconcile provider callbacks as facts that can arrive late, duplicate, or out of order.

## Current Chalk Findings

### As-Is Lifecycle Surfaces

Current API/WS paths are routed in `apps/api/internal/interfaces/http/router.go:267-307`:

- Room control: `POST /api/v1/rooms`, `POST /api/v1/rooms/schedule`, `POST /api/v1/rooms/:id/end`, `DELETE /api/v1/rooms/:id`.
- Participant control: `POST /api/v1/rooms/:id/participants`, `DELETE /api/v1/rooms/:id/participants/:pid`, `POST /api/v1/rooms/:id/participants/:pid/token`.
- Recording control: `POST /api/v1/rooms/:id/recordings/start`, `POST /api/v1/rooms/:id/recordings/stop`, `POST /api/v1/rooms/:id/recordings/sync`.
- Live room channel: `GET /ws`.

The persisted room state machine is only `scheduled | active | ended`. The initial schema started with `active | ended` in `apps/api/db/migrations/001_initial_schema.sql:48-55`; scheduling later widened the check constraint to `scheduled | active | ended` in `apps/api/db/migrations/011_room_scheduling.sql:9-12`.

The current implicit state machines are:

```text
Room:
  scheduled -> active -> ended
  ended -> active  (reactivation path, same room_id, new Cloudflare meeting_id)

Participant:
  active == participants.left_at IS NULL
  left   == participants.left_at IS NOT NULL

Recording:
  recording -> processing -> ready -> archived/deleted
  failed was added after the original schema because the service already wrote it
  (apps/api/db/migrations/005_add_failed_recording_status.sql:1-8).

WebSocket connection:
  registered in hub memory -> unregistered on socket close
```

### Room Creation, Scheduling, and Ending

`CreateRoom` calls Cloudflare before inserting the `rooms` row, then tries to roll back the provider meeting if the DB insert fails (`apps/api/internal/domain/room/service.go:133-149`). That means provider state is created outside a database transition.

Scheduled rooms also create the Cloudflare meeting immediately, before the scheduled room is inserted (`apps/api/internal/domain/room/service.go:201-228`). Activation later only updates the Chalk DB status (`apps/api/internal/domain/participant/service.go:361-391`). A scheduled room that is never joined has a provider meeting long before there is an active Chalk session.

`EndRoom` broadcasts `room.ended` before the database row is marked ended (`apps/api/internal/domain/room/service.go:381-397`). It then best-effort stops recording, ignores the Cloudflare `EndMeeting` result, updates the DB, and clears Redis room state (`apps/api/internal/domain/room/service.go:399-417`). The SQL update has no status guard or revision check (`apps/api/db/queries/rooms.sql:87-93`).

`ReactivateRoom` unconditionally changes an ended room back to active with a new Cloudflare meeting ID (`apps/api/db/queries/rooms.sql:95-103`), and the join path creates the new Cloudflare meeting before that DB update (`apps/api/internal/domain/participant/service.go:394-437`). This reuses one `room_id` for multiple provider meeting instances without a session ID or revision boundary.

### Participant Join and Leave

The participant join handler accepts a room UUID or a room name. For room-name joins, it can deterministically create a room ID and allow create-on-missing (`apps/api/internal/interfaces/http/handlers/participants.go:86-135`). The response includes `should_start_recording`, making recording start partly a client-followup behavior (`apps/api/internal/interfaces/http/handlers/participants.go:201-221`).

Join checks capacity by reading active participant count from `GetRoomWithParticipantCount` and comparing it to tenant limits (`apps/api/internal/domain/participant/service.go:457-459`; SQL in `apps/api/db/queries/rooms.sql:118-125`). The count and subsequent insert are not in one transaction, so concurrent joins can over-admit.

Duplicate external-user handling is read-before-write. It fetches the latest participant by room and external user, then if `left_at` is null refreshes the Cloudflare token and returns it (`apps/api/internal/domain/participant/service.go:490-534`; SQL in `apps/api/db/queries/participants.sql:27-31`). There is no active partial unique index on `(room_id, external_user_id)` and no compare-and-set participant session record.

New participant creation calls Cloudflare first and then inserts `participants` (`apps/api/internal/domain/participant/service.go:538-566`). If the DB insert fails, the Cloudflare participant is orphaned. The DB row is considered active immediately, before the SDK has joined RTK media or established the Chalk WebSocket.

`LeaveRoom` unconditionally sets `left_at = NOW()` and broadcasts `participant.left` (`apps/api/internal/domain/participant/service.go:832-854`; SQL in `apps/api/db/queries/participants.sql:55-59`). Repeated leave updates rewrite `left_at` and can duplicate leave effects.

### WebSocket Presence and Reconnect

The WebSocket handshake validates the JWT and required claims, but does not validate that the room is still active, that the participant belongs to the current room session, or that `left_at` is still null (`apps/api/internal/interfaces/http/handlers/websocket.go:112-184`). The handler correctly uses `context.Background()` after upgrade to avoid request-context cancellation (`apps/api/internal/interfaces/http/handlers/websocket.go:372-384`).

The hub sends `connected`, then a snapshot, then broadcasts `participant.joined` from the socket registration path (`apps/api/internal/interfaces/websocket/hub.go:273-301`). The participant service also broadcasts `participant.joined` after DB insert (`apps/api/internal/domain/participant/service.go:594-608`), so the system has two join emitters.

On any WebSocket unregister, the hub calls `participantService.LeaveRoom` (`apps/api/internal/interfaces/websocket/hub.go:304-344`). That means a socket close is interpreted as an intentional participant leave, even though the SDK reconnect path treats WebSocket closure as recoverable (`packages/sdk-core/src/ws-client/base.ts:159-195`). This is the main reconnect/cleanup hazard.

The SDK calls the API to add a participant, then joins RTK, then connects WebSocket (`packages/sdk-core/src/conference-client/join-session.ts:47-135`). If RTK join fails after the API participant is created, catch cleanup only disconnects WebSocket (`packages/sdk-core/src/conference-client/join-session.ts:153-156`), so the DB participant may remain active. The explicit leave flow disconnects WebSocket before RTK leave (`packages/sdk-core/src/conference-session/leave-flow.ts:32-40`), which can mark the participant left while the media provider still has cleanup in progress.

The SDK inbound handler does not include `room.ended`; it handles `room.updated`, `room.snapshot`, `room.sync`, participant, recording, chat, and error events (`packages/sdk-core/src/ws-client/inbound-handlers.ts:91-110`). A `room.ended` broadcast can therefore be ignored by current client surfaces unless another layer handles unknown messages.

### Redis, Hub Memory, and Multi-Instance Projection

Redis room state stores participant metadata and recording state with a fixed two-hour TTL (`apps/api/internal/infrastructure/redis/room_state.go:13-17`, `apps/api/internal/infrastructure/redis/room_state.go:27-44`, `apps/api/internal/infrastructure/redis/room_state.go:70-82`). It is a cache/projection, not a canonical lifecycle source.

Room snapshots can load participants from Redis, but if Redis has no participants the hub falls back to local in-memory state (`apps/api/internal/interfaces/websocket/hub.go:591-619`). Snapshot `LastSeq` is set to wall-clock milliseconds, not a durable room revision (`apps/api/internal/interfaces/websocket/hub.go:616-617`).

The hub keeps recording state in local memory (`roomRecording`) and deletes it when the last local socket leaves (`apps/api/internal/interfaces/websocket/hub.go:390-393`). The Redis `GetRecordingState` path exists, but the shown snapshot path only rehydrates participants from room-state source. Multi-instance clients can therefore disagree on recording display unless an event or local setter reached their instance.

### Empty Cleanup

The cleanup job lists active rooms whose `created_at` is older than a timeout and whose active participant count is zero, then calls `EndRoom` (`apps/api/internal/infrastructure/jobs/room_cleanup.go:33-69`; SQL in `apps/api/db/queries/rooms.sql:178-184`). It does not track `last_empty_at`, `disconnect_grace_until`, room revision, or active recording. Combined with WebSocket unregister marking participants left, transient reconnects can end long-lived rooms as soon as the roster briefly hits zero.

### Recording Lifecycle

`StartRecording` loads the room, calls Cloudflare `StartRecording`, then inserts the DB row with status `recording` (`apps/api/internal/domain/recording/service.go:70-98`). The DB active-recording query is a plain read (`apps/api/db/queries/recordings.sql:23-26`), and `CreateRecording` has no unique partial index for one active recording per room (`apps/api/db/queries/recordings.sql:4-13`).

`StopRecording` reads the active recording, ignores Cloudflare stop errors, then marks the DB row `processing` (`apps/api/internal/domain/recording/service.go:116-153`; SQL in `apps/api/db/queries/recordings.sql:55-61`). The room end path treats recording stop failures as informational (`apps/api/internal/domain/room/service.go:399-406`).

Recording webhook handling records the `dyte-signature` and `dyte-webhook-id` headers, but the shown handler reads and logs the raw body and proceeds to parse/process without signature verification in this function (`apps/api/internal/interfaces/http/handlers/webhooks.go:63-118`). There is a stalled-recording checker that polls Cloudflare after one hour for `processing` rows (`apps/api/internal/infrastructure/jobs/recording_check.go:36-105`), which is good reconciliation scaffolding but too late to be the primary lifecycle guard.

## Sources of Truth Today

| Surface                 | Current role                                          | Current risk                                                                              |
| ----------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Postgres `rooms`        | Canonical-ish room status and provider meeting ID     | No lifecycle revision, no session instance, unconditional transitions                     |
| Postgres `participants` | Canonical-ish roster via `left_at`                    | API join writes active before media active; WS close writes leave                         |
| Postgres `recordings`   | Recording persistence                                 | No `starting/stopping`, no active unique guard, provider calls outside transaction        |
| Cloudflare RTK          | Media/control provider                                | Called before or after DB depending on operation; provider failures are often best effort |
| Redis room state        | Participant and recording projection                  | TTL-based, cleared on room end, not revisioned                                            |
| Hub memory              | Per-instance sockets, room snapshots, recording flags | Multi-instance drift, duplicate join/left emitters                                        |
| Redis Pub/Sub           | Best-effort fanout                                    | No durable replay, no ordered room revision                                               |
| SDK RTK state           | Real media connectivity                               | Not the same as API participant active state                                              |
| Webhooks/jobs           | Recording and external delivery reconciliation        | Recording webhook is not yet a verified/deduped control-plane event                       |

## Production Systems to Learn From

### LiveKit

Primary sources:

- Official room management docs: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/rooms/>
- Official webhooks/events docs: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>
- Official room service API reference: <https://docs.livekit.io/reference/other/roomservice-api/>
- Source snapshot inspected at `livekit/livekit@7c319a67d41350ca0d58e6e8291b70cae22b8756`.

LiveKit makes a room a LiveKit session container. Rooms can be created explicitly through server API or automatically on first participant join, and the room closes shortly after the last participant leaves according to docs. Its room service API exposes `empty_timeout`, `departure_timeout`, and `max_participants`; the API docs define `empty_timeout` as the time to keep a room open if nobody joins and `departure_timeout` as the time after the last participant leaves.

The source makes the reconnect grace explicit. `Room.CloseIfEmpty` uses `DepartureTimeout` if the room has had a participant and `LastLeftAt` is set, with a comment that it gives time in case a participant is reconnecting; otherwise it uses `EmptyTimeout` from creation time. When elapsed time exceeds the selected timeout it closes the room (`pkg/rtc/room.go:780-794`, GitHub: <https://github.com/livekit/livekit/blob/7c319a67d41350ca0d58e6e8291b70cae22b8756/pkg/rtc/room.go#L780-L794>). Defaults are five minutes empty timeout and 20 seconds departure timeout (`pkg/config/config.go:415-416`, GitHub: <https://github.com/livekit/livekit/blob/7c319a67d41350ca0d58e6e8291b70cae22b8756/pkg/config/config.go#L415-L416>).

LiveKit also distinguishes signal connection, media active, and participant cleanup. The official webhook docs say `participant_joined` fires after the participant becomes active, and `participant_connection_aborted` exists for connection failure after signaling. In source, `ParticipantActive` emits the `participant_joined` webhook, while `ParticipantLeft` can emit `participant_connection_aborted` if the participant was never connected (`pkg/telemetry/events.go:108-123`, `pkg/telemetry/events.go:183-218`, GitHub: <https://github.com/livekit/livekit/blob/7c319a67d41350ca0d58e6e8291b70cae22b8756/pkg/telemetry/events.go#L108-L218>).

Borrow for Chalk:

- Separate API admission from media-active presence.
- Track an explicit empty-room grace after last active participant, not merely zero DB rows.
- Emit `participant.connection_aborted` or `participant.join_failed` when RTK/media never became active.
- Include room/session revisions in webhooks/events the way LiveKit includes event IDs and timestamps in webhook payloads.

### Jitsi / Jicofo / Prosody / JVB

Primary sources:

- Official Jitsi architecture docs: <https://jitsi.github.io/handbook/docs/architecture/>
- Source snapshot inspected at `jitsi/jicofo@ed8f3c4df08929d026ffe022d92145eeeb529593`.

Jitsi's architecture splits concerns. The handbook describes JVB as the WebRTC media router, Jicofo as the server-side focus component that manages media sessions and load-balances participants to the bridge, and Prosody as the XMPP signaling server. That separation is useful for Chalk even though Chalk uses Cloudflare as the media provider: the application control plane should not confuse API room rows, signaling membership, provider media endpoints, and recording bots.

Jicofo's `FocusManager` owns an in-memory map of conferences by MUC room name and creates or returns an existing `JitsiMeetConference` under a synchronization boundary (`FocusManager.kt:90-117`, GitHub: <https://github.com/jitsi/jicofo/blob/ed8f3c4df08929d026ffe022d92145eeeb529593/jicofo/src/main/kotlin/org/jitsi/jicofo/FocusManager.kt#L90-L117>). When a conference ends, the manager removes it from all indexes and notifies listeners (`FocusManager.kt:149-173`, GitHub: <https://github.com/jitsi/jicofo/blob/ed8f3c4df08929d026ffe022d92145eeeb529593/jicofo/src/main/kotlin/org/jitsi/jicofo/FocusManager.kt#L149-L173>).

The conference object has a real stop boundary. `JitsiMeetConferenceImpl.stop()` uses an atomic started flag, shuts down recording/SIP helpers, expires bridge sessions, leaves the room, records metrics, and calls `conferenceEnded` (`JitsiMeetConferenceImpl.java:452-522`, GitHub: <https://github.com/jitsi/jicofo/blob/ed8f3c4df08929d026ffe022d92145eeeb529593/jicofo/src/main/java/org/jitsi/jicofo/conference/JitsiMeetConferenceImpl.java#L452-L522>). On member leave, it terminates the participant, expires bridge sessions when empty, and stops when the last member leaves except for breakout-room exceptions (`JitsiMeetConferenceImpl.java:1044-1105`, GitHub: <https://github.com/jitsi/jicofo/blob/ed8f3c4df08929d026ffe022d92145eeeb529593/jicofo/src/main/java/org/jitsi/jicofo/conference/JitsiMeetConferenceImpl.java#L1044-L1105>).

Borrow for Chalk:

- Add a room/session coordinator boundary that is responsible for serialized transitions, not distributed handler side effects.
- Treat provider media endpoints as resources attached to a session and expire them explicitly.
- Let room cleanup consider special states like breakout/recording/draining equivalents instead of only "zero participants".

### BigBlueButton

Primary sources:

- Official BigBlueButton API docs: <https://docs.bigbluebutton.org/development/api/>
- Source snapshot inspected at `bigbluebutton/bigbluebutton@667f08370edb64629b670748b73f8a1595bce63e`.

BigBlueButton exposes create/join/isMeetingRunning/end at the API boundary. Its docs state `isMeetingRunning` returns whether a meeting ID is currently running and `end` sends a request to forcibly end the meeting and kick users, after which clients should verify with `getMeetingInfo` or `isMeetingRunning`.

BBB also protects reusable meeting IDs with `createTime`: the docs say join URLs can pass the `createTime` returned by create, and BBB refuses the join if it does not match the current session. This is directly relevant to Chalk's current ended-room reactivation problem: a stable room name/ID needs a per-session epoch.

In source, BBB's `MeetingExpiryTracker` has explicit inputs for `userHasJoined`, `lastUserLeftOnInMs`, `meetingExpireIfNoUserJoinedInMs`, `meetingExpireWhenLastUserLeftInMs`, duration, and no-moderator policy (`MeetingTrackers.scala:3-17`, GitHub: <https://github.com/bigbluebutton/bigbluebutton/blob/667f08370edb64629b670748b73f8a1595bce63e/akka-bbb-apps/src/main/scala/org/bigbluebutton/core/domain/MeetingTrackers.scala#L3-L17>). It returns specific end reasons for never-joined, over-duration, and last-user-left expiry (`MeetingTrackers.scala:56-65`, GitHub: <https://github.com/bigbluebutton/bigbluebutton/blob/667f08370edb64629b670748b73f8a1595bce63e/akka-bbb-apps/src/main/scala/org/bigbluebutton/core/domain/MeetingTrackers.scala#L56-L65>).

BBB's recording pipeline is also instructive. On ended meetings, the service processes recordings and writes an ended marker after the recorded marker to avoid concurrency issues in recording scripts (`MeetingService.java:971-980`, GitHub: <https://github.com/bigbluebutton/bigbluebutton/blob/667f08370edb64629b670748b73f8a1595bce63e/bbb-common-web/src/main/java/org/bigbluebutton/api/MeetingService.java#L971-L980>). The recording starter checks for missed `.done` files on startup before watching directories (`rap-starter.rb:97-144`, GitHub: <https://github.com/bigbluebutton/bigbluebutton/blob/667f08370edb64629b670748b73f8a1595bce63e/record-and-playback/core/scripts/rap-starter.rb#L97-L144>).

Borrow for Chalk:

- Add `session_id` or `session_revision` to every join token, WS message, webhook, and recording row, like BBB's `createTime` join protection.
- Make expiry reasons first-class: `never_joined`, `last_participant_left`, `duration_exceeded`, `host_absent`, `ended_by_host`, `provider_ended`, `system_cleanup`.
- Separate meeting end from recording processing, and make post-meeting processing resilient to missed events.

### Twilio Video

Primary sources:

- Rooms API: <https://www.twilio.com/docs/video/api/rooms-resource>
- Participants API: <https://www.twilio.com/docs/video/api/participants>
- Status callbacks: <https://www.twilio.com/docs/video/api/status-callbacks>
- Reconnection states/events: <https://www.twilio.com/docs/video/reconnection-states-and-events>

Twilio rooms have terminal statuses like `in-progress` and `completed`; completing a room disconnects connected participants. Twilio's callback event list includes `room-created`, `room-ended`, `participant-connected`, `participant-disconnected`, and recording events. Its status callback docs explicitly warn that `SequenceNumber` is internal and not true event order; consumers should use timestamps to relate events.

Twilio participant resources support `connected`, `disconnected`, and `reconnecting` statuses. The reconnection docs distinguish `connected`, `reconnecting`, and `disconnected` at both room and remote participant levels, and call out token expiry as a reconnection failure mode.

Borrow for Chalk:

- Represent `reconnecting` as a server-side participant/session state, not just a client state.
- Make callbacks/events idempotent and timestamped, but do not treat provider sequence numbers as the sole ordering source.
- Token refresh should check current session/revision and participant-session status before issuing a new token.

### AWS Chime SDK

Primary source: <https://docs.aws.amazon.com/chime-sdk/latest/dg/using-events.html>

AWS Chime SDK sends meeting lifecycle events to EventBridge, SNS, or SQS. The docs show `MeetingStarted`, `MeetingEnded`, `AttendeeAdded`, `AttendeeJoined`, `AttendeeDropped`, and `AttendeeLeft` style events, including a lifecycle where a user joins, drops due to connection loss, rejoins, and later leaves.

Borrow for Chalk:

- Treat provider events as an event stream feeding reconciliation, not as direct handler-side mutations.
- Preserve distinct `dropped` vs `left` semantics. A network drop is not an intentional leave until grace expires.
- Route high-value lifecycle events through durable delivery or at least an inbox/outbox table rather than goroutine-only processing.

### Google Meet Public API

Primary sources:

- Conference records: <https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords>
- Participant sessions: <https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants.participantSessions>

Google's public Meet API is mostly post-meeting/audit oriented, not a full live control-plane design. Still, it exposes useful vocabulary: a `ConferenceRecord` is a single instance of a meeting held in a space, with `startTime`, `endTime`, `expireTime`, and `space`; a `ParticipantSession` is each unique join/leave session from a device, and repeated joins receive different IDs.

Borrow for Chalk:

- Model stable room/space separately from each meeting instance.
- Model participant identity separately from each join/leave/device session.
- Keep post-meeting records immutable enough that recordings, transcripts, and analytics do not depend on a mutable active-room row.

## Proposed Chalk Control Plane

### Core Principle

Postgres should be the source of truth for lifecycle intent and revisioned transitions. Cloudflare, Redis, hub memory, WebSocket fanout, post-meeting jobs, and tenant webhooks should react to those transitions.

The control plane should use a single canonical identity stack:

```text
room                stable logical room/name/template
room_session        one live or historical meeting instance for a room
participant         stable app/user identity in a room/tenant context
participant_session one join/leave/reconnect lifecycle within a room_session
participant_connection optional per-device/socket/media connection record
recording_session   one recording lifecycle attached to a room_session
room_event          ordered event log/outbox projection
```

### Room Session State Machine

Recommended state machine:

```text
scheduled
  -> opening
  -> open
  -> active
  -> empty_grace
  -> active
  -> draining
  -> ending
  -> ended

scheduled -> canceled
opening   -> failed
open      -> expired          (never joined before configured deadline)
active    -> ending           (host/API/system/provider end)
empty_grace -> ending         (grace elapsed)
draining  -> ending           (all participants disconnected or deadline elapsed)
ending    -> ended
ending    -> ending_failed    (operator/reconciler attention, still terminal for joins)
```

State meanings:

- `scheduled`: Join window not open. Prefer no provider meeting yet unless provider prewarm is deliberately configured.
- `opening`: DB session row exists, provider meeting creation is in progress, no user admission except idempotent retry.
- `open`: Provider meeting exists, join window open, zero active participants.
- `active`: One or more participant sessions are media-active or server-connected.
- `empty_grace`: Last active participant left/dropped; reconnect and late join may still reactivate before deadline.
- `draining`: No new joins. Existing clients receive end/drain event; recordings and provider resources are stopping.
- `ending`: Provider end and DB terminalization are being reconciled.
- `ended`: Terminal; old tokens cannot join; post-meeting artifacts continue independently.
- `failed`: Terminal for failed opening.
- `canceled`/`expired`: Terminal for never-started scheduled/open sessions.

Do not reactivate an `ended` session. If Chalk wants recurring/named rooms, create a new `room_session` for the same `room_id`.

### Participant Session State Machine

Recommended state machine:

```text
reserved
  -> joining
  -> signaling_connected
  -> media_active
  -> reconnecting
  -> media_active
  -> left

joining -> join_failed
signaling_connected -> join_failed
media_active -> kicked
media_active -> reconnecting -> expired
media_active -> removed_by_room_end
```

State meanings:

- `reserved`: Join request accepted and participant session allocated; no provider participant yet.
- `joining`: Provider token/participant issued; client is expected to connect.
- `signaling_connected`: Chalk WS and/or provider signal connected.
- `media_active`: Provider reports media connection active, or Chalk's best available provider signal says the participant is truly in the meeting.
- `reconnecting`: Signal/media/socket dropped, but `disconnect_grace_until` has not elapsed.
- Terminal states: `left`, `kicked`, `expired`, `join_failed`, `removed_by_room_end`.

Important distinction: `participants.left_at IS NULL` is not enough for presence. `left_at` should become a terminal participant-session timestamp, not a low-level socket close timestamp.

### Recording Session State Machine

Recommended state machine:

```text
idle (derived, no active row)
  -> starting
  -> recording
  -> stopping
  -> processing
  -> ready
  -> archived
  -> deleted

starting -> failed
recording -> failed
stopping -> failed_needs_reconcile
processing -> failed
```

Start and stop should be compare-and-set transitions:

- `idle -> starting`: DB transaction creates `recording_session`, increments room revision, inserts outbox command.
- `starting -> recording`: Provider start succeeds or provider webhook confirms.
- `recording -> stopping`: Stop intent accepted.
- `stopping -> processing`: Provider stop accepted or provider reports upload/processing.
- `processing -> ready`: Download/upload complete.

Only one active recording session per `room_session` should be possible across `starting | recording | stopping | processing`.

## Transition Boundaries and Sources of Truth

### Database Transitions

Every lifecycle mutation should be an explicit Postgres transaction:

1. Lock or CAS the `room_session` row with `WHERE id = $1 AND revision = $expected_revision AND status IN (...)`.
2. Write the new status, `revision = revision + 1`, transition reason, actor, and timestamp.
3. Insert a `room_events` row with `(room_id, room_session_id, revision, event_type, event_id, payload)`.
4. Insert an outbox row for side effects: provider create/end, participant add/remove, recording start/stop, tenant webhook delivery, Redis fanout.
5. Commit.

External calls should run after commit. If an external call fails, the system should transition into a retryable/reconciling state rather than pretending the lifecycle finished.

### Provider Boundaries

Cloudflare provider IDs should be scoped to `room_session_id`, not just `room_id`.

Provider callback ingestion should:

- Verify signature before parsing side effects.
- Store `(provider, provider_event_id)` in a dedupe table.
- Resolve by `provider_meeting_id` and `room_session_id`.
- Ignore or quarantine events for old sessions.
- Apply state changes with revision checks.

### Redis and Hub Boundaries

Redis should store only projection keys that include `room_session_id`:

```text
room_session:{session_id}:participants
room_session:{session_id}:recording
room_session:{session_id}:snapshot:{revision}
```

WebSocket events should always include:

```json
{
  "event_id": "uuid",
  "room_id": "uuid",
  "room_session_id": "uuid",
  "revision": 42,
  "occurred_at": "2026-05-30T..."
}
```

The hub should drop any event older than the latest revision it has delivered to a client and should allow clients to request `room.sync` from a specific revision. Redis Pub/Sub can remain the low-latency path, but the authoritative replay source should be `room_events`.

## Dangerous Races to Close

### Duplicate Join and Over-Capacity

Current shape:

- Read active participant count.
- Maybe read latest participant for external user.
- Call Cloudflare.
- Insert participant row.

Race:

- Two join requests for the same external user both miss the active row and both create provider participants.
- Two or more joins pass capacity before any insert commits.

Fix:

- Add `participant_sessions` and a partial unique index for active identity per session.
- Admit with a DB transaction before provider call: reserve capacity, reserve identity, increment revision.
- Use idempotency key `(tenant_id, room_session_id, external_user_id, client_join_id)`.
- If provider add fails, transition reserved session to `join_failed` and release capacity.

### Reconnect vs Leave

Current shape:

- WebSocket close calls `LeaveRoom`.
- SDK may be reconnecting the WebSocket and/or RTK media.
- Empty cleanup sees no active DB participants and can end the room.

Fix:

- Socket close transitions `media_active -> reconnecting` with `disconnect_grace_until`, not `left`.
- Explicit user leave transitions to `left` immediately and revokes provider participant/token.
- Provider `participant_left` or RTK disconnect should also start reconnect grace unless accompanied by explicit leave/kick/room end.
- Cleanup only ends `empty_grace` rooms whose grace deadline has elapsed and whose revision still matches.

### End Room vs Join

Current shape:

- `EndRoom` broadcasts before DB end.
- Joins can proceed against an active row while ending is in flight.
- Old tokens do not carry a session/revision boundary.

Fix:

- First transaction: `active/open/empty_grace -> draining`, increment revision, emit `room.lifecycle.changed`.
- Join endpoint rejects `draining|ending|ended` unless it is an idempotent retry for a participant already in that session.
- WS handshake checks token `room_session_id` and `session_revision >= min_join_revision`.
- Provider end and recording stop happen from outbox workers.

### Host Left

Current shape:

- Host is just a participant role.
- `GetRoomHost` can find the earliest active host, but no room policy transition is attached to host leave (`apps/api/db/queries/participants.sql:71-75`).

Fix:

- Tenant/room policy: `keep_open`, `promote_next`, `end_after_host_grace`, or `require_host_to_start`.
- Add `host_absent_since` and `host_grace_until` to room session or policy table.
- Emit `room.host.changed` and `room.host_absent` events.

### Recording Active vs Room End

Current shape:

- Room end best-effort stops active recording and proceeds.
- Recording state is partly DB, partly Redis, partly hub memory.

Fix:

- Room `draining` should gate on a recording stop intent.
- `ending` may be terminal for joins, but the room session should keep `recording_finalization_status`.
- Use a recording-session outbox and a reconciliation job that checks provider state by provider recording ID and room session.

### Provider Webhooks

Current shape:

- Recording webhook handler records signature presence but the shown code does not verify it before processing.
- The raw body is added to structured event data.
- Work is acknowledged and then a goroutine downloads/processes.

Fix:

- Verify signature before parsing business payload.
- Store the raw payload in a private/durable inbox if needed, not ordinary logs.
- Ack only after inbox commit.
- Process from a worker with retries and dedupe.
- Apply provider events only if they match the current `room_session_id` or are explicitly historical artifact events.

### Multi-Instance Fanout

Current shape:

- Hub memory and Redis Pub/Sub carry live events.
- Snapshot sequence is wall-clock time.
- Redis participant state has TTL but no revision.

Fix:

- All fanout messages derive from `room_events`.
- Redis Pub/Sub carries event IDs/revisions only as fast delivery.
- Snapshot query returns the latest committed `room_session.revision`.
- Clients de-dupe by `(room_session_id, revision, event_id)`.

## Concrete Data Model Additions

### Minimal Additive Schema

```sql
CREATE TABLE room_sessions (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'cloudflare_realtimekit',
  provider_meeting_id TEXT,
  status TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  scheduled_start_at TIMESTAMPTZ,
  scheduled_end_at TIMESTAMPTZ,
  join_window_opens_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ,
  last_empty_at TIMESTAMPTZ,
  empty_grace_until TIMESTAMPTZ,
  draining_started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  ended_by_participant_session_id UUID,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX room_sessions_one_nonterminal_per_room
ON room_sessions(room_id)
WHERE status IN ('scheduled', 'opening', 'open', 'active', 'empty_grace', 'draining', 'ending', 'ending_failed');

CREATE UNIQUE INDEX room_sessions_provider_meeting_id_unique
ON room_sessions(provider, provider_meeting_id)
WHERE provider_meeting_id IS NOT NULL;
```

```sql
CREATE TABLE participant_sessions (
  id UUID PRIMARY KEY,
  room_session_id UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id UUID,
  external_user_id TEXT,
  display_name TEXT,
  role TEXT NOT NULL,
  provider_participant_id TEXT,
  status TEXT NOT NULL,
  connection_epoch BIGINT NOT NULL DEFAULT 0,
  joined_intent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signaling_connected_at TIMESTAMPTZ,
  media_active_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  reconnecting_at TIMESTAMPTZ,
  disconnect_grace_until TIMESTAMPTZ,
  left_at TIMESTAMPTZ,
  leave_reason TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX participant_sessions_one_active_external_user
ON participant_sessions(room_session_id, external_user_id)
WHERE external_user_id IS NOT NULL
  AND status IN ('reserved', 'joining', 'signaling_connected', 'media_active', 'reconnecting');
```

```sql
CREATE TABLE recording_sessions (
  id UUID PRIMARY KEY,
  room_session_id UUID NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider_recording_id TEXT,
  status TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0,
  requested_by_participant_session_id UUID,
  started_at TIMESTAMPTZ,
  stopping_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX recording_sessions_one_active_per_room_session
ON recording_sessions(room_session_id)
WHERE status IN ('starting', 'recording', 'stopping', 'processing');
```

```sql
CREATE TABLE room_events (
  id UUID PRIMARY KEY,
  room_id UUID NOT NULL,
  room_session_id UUID NOT NULL,
  revision BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(room_session_id, revision),
  UNIQUE(room_session_id, id)
);

CREATE TABLE provider_event_inbox (
  id UUID PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_meeting_id TEXT,
  room_session_id UUID,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  UNIQUE(provider, provider_event_id)
);
```

### Compatibility Columns

During migration, keep `rooms.status` for old API responses but make it a projection:

- `rooms.active_session_id`
- `rooms.lifecycle_status` or continue projecting `scheduled|active|ended`
- `rooms.lifecycle_revision`

Eventually, prefer API responses that expose both:

```json
{
  "room": { "id": "...", "name": "...", "status": "active" },
  "session": {
    "id": "...",
    "status": "active",
    "revision": 42,
    "provider_meeting_id": "..."
  }
}
```

## Events and APIs to Add

### WebSocket Events

Use one lifecycle event family with revisioned payloads:

- `room.lifecycle.changed`
- `participant.session.changed`
- `participant.connection.changed`
- `recording.lifecycle.changed`
- `room.host.changed`
- `room.snapshot`
- `room.sync`

Example:

```json
{
  "type": "participant.session.changed",
  "event_id": "7e3...",
  "room_id": "7a1...",
  "room_session_id": "2d6...",
  "revision": 43,
  "occurred_at": "2026-05-30T10:42:12Z",
  "payload": {
    "participant_session_id": "9c1...",
    "external_user_id": "user_123",
    "from": "media_active",
    "to": "reconnecting",
    "reason": "ws_closed",
    "disconnect_grace_until": "2026-05-30T10:42:42Z"
  }
}
```

### API Additions and Changes

- `POST /api/v1/rooms/:id/sessions`: create/open a new session for a reusable room.
- `GET /api/v1/rooms/:id/sessions/current`: return active/open/scheduled current session.
- `POST /api/v1/rooms/:id/end`: require or return `room_session_id`, accept `expected_revision`, `idempotency_key`, and `reason`.
- `POST /api/v1/rooms/:id/participants`: return `participant_session_id`, `room_session_id`, `revision`, and token scope.
- `POST /api/v1/rooms/:id/participants/:pid/leave`: explicit leave endpoint; do not use WebSocket close as equivalent.
- `POST /api/v1/rooms/:id/recordings/start`: accept `expected_revision` and `idempotency_key`.
- `POST /api/v1/rooms/:id/recordings/stop`: accept `recording_session_id`, `expected_revision`, and `idempotency_key`.

Token claims should include:

```json
{
  "room_id": "...",
  "room_session_id": "...",
  "participant_session_id": "...",
  "session_revision": 42,
  "connection_epoch": 3
}
```

WS handshake and refresh-token flows should reject tokens for ended sessions, superseded revisions, terminal participant sessions, or stale connection epochs.

## Migration Plan

### Phase 1: Additive Observability and Schema

- Add `room_sessions`, `participant_sessions`, `recording_sessions`, `room_events`, `provider_event_inbox`, and outbox tables.
- Backfill one `room_session` per non-deleted current `rooms` row.
- Add `active_session_id` and `lifecycle_revision` projections to `rooms`.
- Start emitting `room_session_id` and `revision` in snapshots while keeping old fields.
- Add dashboards/queries for rooms whose Postgres, Redis, hub, and provider state disagree.

### Phase 2: Join and Reconnect Safety

- Move participant join to reserve a `participant_session` before provider calls.
- Add unique indexes for active participant identity and capacity reservation.
- Change WS unregister from leave to `reconnecting` unless the close is tied to explicit SDK leave.
- Add a short heartbeat or provider/media-active confirmation before moving `joining -> media_active`.
- Add cleanup for `joining` sessions that never become active.

### Phase 3: Room End and Empty Grace

- Replace direct `EndRoom` mutation with `active/open/empty_grace -> draining -> ending -> ended`.
- Add empty grace worker based on `last_empty_at` and `empty_grace_until`.
- Make join reject `draining|ending|ended`.
- Stop reactivating ended rooms in place; create a new `room_session`.

### Phase 4: Recording Control Plane

- Add `starting/stopping` recording states and one-active-recording partial unique index.
- Move provider start/stop into outbox workers.
- Verify and dedupe provider webhooks.
- Make room ending wait on a bounded recording stop/finalization policy.
- Rework force-recording from client follow-up to server-side room-session policy.

### Phase 5: Event Replay and Fanout

- Persist all lifecycle events in `room_events`.
- Publish events to Redis after DB commit.
- Let clients call `room.sync` with last seen revision.
- Make snapshots revisioned and session-scoped.
- Remove duplicate `participant.joined` emitters.

## Test and Chaos Plan

### Database and Unit Tests

- Room session CAS: only valid transitions succeed; stale `expected_revision` fails.
- One active room session per room.
- Ended session cannot reactivate; same room can start a new session.
- One active participant session per `(room_session_id, external_user_id)`.
- Capacity reservation stays correct under concurrent joins.
- Participant `reconnecting -> media_active` within grace does not emit `left`.
- Participant `reconnecting -> expired` after grace emits one terminal leave.
- One active recording per session across `starting|recording|stopping|processing`.
- Duplicate provider webhook is ignored after first inbox commit.

### API Integration Tests

- Concurrent duplicate joins for same external user return same participant session or one conflict, not two provider participants.
- Concurrent joins at capacity admit exactly the allowed count.
- API join succeeds but RTK/media join fails: participant session becomes `join_failed`, room does not count it active.
- WS close then reconnect within grace: participant remains in roster as reconnecting/active, room does not end.
- Explicit SDK leave: participant becomes `left` immediately and does not recover on stale reconnect.
- Join racing with host end: end wins by revision and join gets `409 room_draining` or idempotent session result.
- Room end with active recording creates `recording.stopping` and eventually `room.ended` plus `recording.processing/ready`.
- Old token from previous room session cannot connect over `/ws`.

### Multi-Instance Tests

- Two API instances receive joins and WS connects for the same room session; snapshots converge by revision.
- Redis Pub/Sub drops an event; client `room.sync` replays from `room_events`.
- One instance has stale hub memory; snapshot uses DB/Redis revision source and does not resurrect old participants.
- Recording state set on one instance appears in snapshot on another instance.

### Provider and Webhook Chaos

- Cloudflare create meeting succeeds but DB/open transaction fails: outbox/reconciler ends orphan provider meeting.
- DB reserves room session but Cloudflare create times out: state becomes `opening` with retry, not active.
- Cloudflare add participant succeeds but DB participant transition fails: participant is removed by compensating action.
- Cloudflare stop recording fails: recording remains `stopping` and reconciler retries or marks `failed_needs_reconcile`.
- Provider webhook arrives before API response, after room ended, duplicated, and out of order.
- Provider webhook references old provider meeting ID after room name/session reuse.

### Cleanup and Time Chaos

- Scheduled room never joined expires without leaking provider meeting.
- Long-running active room whose last participant briefly reconnects is not ended based on `created_at`.
- Clock skew around scheduled start uses DB/server time consistently.
- Cleanup worker crashes after selecting rooms but before ending; idempotent retry continues.

## Open Decisions

- Is `room` a reusable named space or a single meeting instance? Recommendation: reusable named space, with immutable `room_session` instances.
- Should scheduled sessions create provider meetings at schedule time, join-window time, or first join? Recommendation: default to join-window/first-join, with explicit prewarm option.
- What is the default reconnect grace? Recommendation: start with 30 seconds for WebSocket/media drops and tune using telemetry.
- What is the host-left policy by tenant? Recommendation: support `keep_open`, `promote_next`, and `end_after_host_grace`.
- Should same `external_user_id` have one participant session with multiple device connections or multiple participant sessions? Recommendation: one participant session per user per room session, plus `participant_connections` for devices/tabs, unless product explicitly needs multi-seat behavior.
- How hard should room end wait for recording stop? Recommendation: terminal for joins immediately, bounded provider stop/reconcile in background, visible `recording_finalization_status`.
- How long should event replay be retained? Recommendation: retain room lifecycle events at least as long as recordings/transcripts need audit context; snapshots can compact old revisions.

## Top Architecture Recommendations

1. Add `room_sessions` and stop using `rooms.status` as the only meeting lifecycle source.
2. Add monotonic `revision` and `event_id` to every room, participant, recording, webhook, and WebSocket transition.
3. Replace WebSocket-close-as-leave with participant `reconnecting` grace and explicit leave/kick/end terminals.
4. Move provider calls behind DB intent transitions and outbox/reconciler workers.
5. Scope every token, provider ID, Redis key, and snapshot to `room_session_id` to prevent stale events from crossing session reuse.

## Source Index

Chalk local files:

- `apps/api/internal/domain/room/service.go`
- `apps/api/internal/domain/participant/service.go`
- `apps/api/internal/domain/recording/service.go`
- `apps/api/db/queries/rooms.sql`
- `apps/api/db/queries/participants.sql`
- `apps/api/db/queries/recordings.sql`
- `apps/api/internal/interfaces/websocket/hub.go`
- `apps/api/internal/interfaces/http/handlers/websocket.go`
- `apps/api/internal/interfaces/http/handlers/participants.go`
- `apps/api/internal/interfaces/http/handlers/webhooks.go`
- `apps/api/internal/infrastructure/jobs/room_cleanup.go`
- `apps/api/internal/infrastructure/jobs/recording_check.go`
- `apps/api/internal/infrastructure/redis/room_state.go`
- `packages/sdk-core/src/conference-client/join-session.ts`
- `packages/sdk-core/src/ws-client/base.ts`
- `packages/sdk-core/src/conference-session/leave-flow.ts`

External official docs:

- LiveKit room management: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/rooms/>
- LiveKit webhooks/events: <https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/>
- LiveKit room service API: <https://docs.livekit.io/reference/other/roomservice-api/>
- Jitsi architecture: <https://jitsi.github.io/handbook/docs/architecture/>
- BigBlueButton API: <https://docs.bigbluebutton.org/development/api/>
- Twilio Rooms API: <https://www.twilio.com/docs/video/api/rooms-resource>
- Twilio Participants API: <https://www.twilio.com/docs/video/api/participants>
- Twilio Status Callbacks: <https://www.twilio.com/docs/video/api/status-callbacks>
- Twilio Reconnection: <https://www.twilio.com/docs/video/reconnection-states-and-events>
- AWS Chime SDK lifecycle events: <https://docs.aws.amazon.com/chime-sdk/latest/dg/using-events.html>
- Google Meet conference records: <https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords>
- Google Meet participant sessions: <https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.participants.participantSessions>

External open-source snapshots:

- LiveKit `livekit/livekit@7c319a67d41350ca0d58e6e8291b70cae22b8756`
- Jicofo `jitsi/jicofo@ed8f3c4df08929d026ffe022d92145eeeb529593`
- BigBlueButton `bigbluebutton/bigbluebutton@667f08370edb64629b670748b73f8a1595bce63e`
