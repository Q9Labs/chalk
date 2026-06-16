# Chalk Domain Model

Date: 2026-05-14

## TLDR

Chalk should separate durable product nouns from live connection nouns. The
HTTP API / Control Plane owns durable entities such as organizations, rooms,
sessions, participants, permissions, and issued capabilities. The WebSocket
Plane owns live entities such as connections, presence, subscriptions, sync
cursors, and room-local live state. The SDK owns client-local state and presents
these concepts through developer-friendly abstractions.

This note defines the core domain nouns used across Chalk's SDK, HTTP API /
Control Plane, WebSocket Plane, and Media Plane.

Related notes:

- [chalk-top-level-actors-2026-05-14.md](chalk-top-level-actors-2026-05-14.md)
- [chalk-actor-flows-2026-05-14.md](chalk-actor-flows-2026-05-14.md)
- [chalk-session-lifecycle-2026-05-15.md](chalk-session-lifecycle-2026-05-15.md)
- [chalk-account-boundary-naming-2026-05-16.md](chalk-account-boundary-naming-2026-05-16.md)

## State Categories

| Category           | Meaning                                                                                     | Primary Owner            |
| ------------------ | ------------------------------------------------------------------------------------------- | ------------------------ |
| Durable state      | Product state that should survive restarts and be queryable later.                          | HTTP API / Control Plane |
| Live state         | Room/session state that matters while participants are actively connected.                  | WebSocket Plane          |
| Client-local state | SDK-managed state used for UI, optimistic updates, reconnect, and developer ergonomics.     | SDK                      |
| Media state        | Transport-level audio/video/data state and quality.                                         | Media Plane              |
| Projection         | Derived, rebuildable state copied or summarized for fast reads, analytics, or coordination. | Depends on projection    |

## Projection State

Projection state is a query-friendly or coordination-friendly view derived from
authoritative state owned elsewhere. A projection may be stale, disposable, and
rebuildable. It should not become the hidden source of product truth.

Projection state might capture:

- Current room status: `active_session_ids`, `status`, `last_activity_at`,
  `participant_count`, and current WebSocket region/shard.
- Current session summary: `started_at`, `ended_at`, `duration`,
  `peak_participants`, media provider session ID, and close reason.
- Presence summary: participant online/offline state, last seen time, device
  count, and current role.
- Connection index: connection ID to participant, room, session, and shard while
  the connection is live.
- Resume index: last delivered sequence or cursor for a participant/session.
- Usage aggregates: org/day session minutes, participant minutes, messages,
  reconnects, media minutes, and peak concurrency.
- Dashboard read models: recent rooms, active sessions, current participants,
  and customer-facing status views.

Rule of thumb:

```text
If losing it would lose product truth, it is not just projection state.
If losing it would make reads slower until rebuilt, it can be projection state.
```

## Core Nouns

### Organization

A customer-facing Chalk account boundary for API keys, membership, billing,
configuration, rooms, sessions, webhooks, and usage policy.

Owned by: HTTP API / Control Plane

State category: Durable

Notes:

- An organization is the main administrative boundary for customers or
  applications.
- Organizations own rooms, API keys, webhooks, and billing/entitlement settings.

### API Key

A server-side credential used by a customer's backend or trusted service to call
Chalk APIs.

Owned by: HTTP API / Control Plane

State category: Durable

Notes:

- API keys authenticate trusted callers.
- API keys should not be exposed to browsers or untrusted clients.

### Room

A durable product container that represents a place where participants can meet,
sync, or communicate.

Owned by: HTTP API / Control Plane

State category: Durable

Notes:

- A room may outlive any single live connection or media session.
- A room may have configuration, permissions, metadata, and lifecycle policy.
- Chalk has both rooms and sessions.
- A room can have multiple active sessions at the same time.
- The WebSocket Plane may hold a live room authority while the room is active,
  but it should not be the source of truth for durable room policy.

### Session

A concrete live or historical occurrence inside a room.

Owned by: HTTP API / Control Plane for durable lifecycle; WebSocket Plane for
live behavior while active

State category: Durable + Live

Notes:

- A room can have many sessions over time.
- A room can have multiple active sessions at the same time.
- A session may represent a call, collaboration period, whiteboard period, or
  other bounded active interval.
- The Control Plane should own when a session is created, ended, archived, or
  reported.
- The WebSocket Plane may own live session state while participants are
  connected.

### Participant

A product-level identity participating in a room or session.

Owned by: HTTP API / Control Plane

State category: Durable, with live projections in the WebSocket Plane

Notes:

- A participant is not the same thing as a WebSocket connection.
- One participant may have multiple connections across tabs, devices, or
  reconnect attempts.
- Participant identity should be stable enough to drive permissions, audit
  logs, presence, and SDK events.
- Customer apps need a clear participant identity shape: a Chalk-scoped
  `participant_id`, an optional customer-supplied `external_user_id`, optional
  profile metadata, and role/capability information.
- `connection_id` should usually remain an internal diagnostic/runtime concept,
  not the primary identity exposed to customer apps.

### Connection

A single live WebSocket connection from an SDK client to the WebSocket Plane.

Owned by: WebSocket Plane

State category: Live

Notes:

- A connection belongs to one authenticated client context.
- A participant may have multiple simultaneous or sequential connections.
- Connections should be cheap, transient, and safe to lose.

### Presence

The live availability and room/session status of participants or connections.

Owned by: WebSocket Plane, surfaced through the SDK

State category: Live, optionally projected durably

Notes:

- Presence answers questions such as "who is currently connected?" and "what is
  their live state?"
- Presence should tolerate disconnects, reconnects, and short network flaps.
- Presence itself is live state, but presence events should be durable when
  needed for immersive session replay.

Presence event examples:

- `presence.online`: participant became visible as present in a session.
- `presence.offline`: participant is no longer visible as present in a session.
- `presence.updated`: participant-visible status changed, such as idle, active,
  away, focus mode, or app-defined presence metadata.
- `presence.role_visible`: participant's visible role or display state changed.
- `presence.snapshot`: point-in-time presence state used to anchor replay or
  recover from missing deltas.

### Subscription

A live interest registration saying which room/session events a connection wants
to receive.

Owned by: WebSocket Plane

State category: Live

Notes:

- Subscriptions may be implicit after joining a room/session or explicit for
  narrower event streams.
- Subscriptions should be validated against capability claims.

### Capability

A short-lived signed grant that lets a client access a specific Chalk resource
with specific permissions.

Owned by: HTTP API / Control Plane

State category: Durable issuance record if needed; live enforcement elsewhere

Notes:

- Capabilities bridge product authorization into the WebSocket and Media
  Planes.
- The WebSocket Plane and Media Plane verify capabilities; they do not mint
  product permissions.
- Capability claims should be narrow, scoped, and expire quickly.

Recommended WebSocket capability claims:

- `iss`: Chalk issuer.
- `aud`: WebSocket Plane audience.
- `sub`: participant or caller subject.
- `jti`: unique token ID for audit/revocation if needed.
- `iat`, `nbf`, `exp`: issued-at, not-before, and expiry.
- `org_id`: organization boundary.
- `room_id`: room scope.
- `session_id`: active session scope when known.
- `participant_id`: Chalk participant identity.
- `external_user_id`: customer-supplied user identity when available.
- `role`: product role such as host, presenter, viewer, or guest.
- `scopes`: allowed WebSocket actions such as `connect`, `sync:read`,
  `sync:write`, `presence:read`, `presence:write`, or `subscribe`.
- `protocol`: allowed protocol version or version range if needed.
- `region` or `shard`: optional routing hint, not product authority.

### Media Grant

A capability or token that allows access to media infrastructure for a room or
session.

Owned by: HTTP API / Control Plane for authorization; Media Plane for transport
enforcement

State category: Durable issuance record if needed; media runtime enforcement

Notes:

- Media grants may wrap or correspond to Cloudflare RealtimeKit tokens,
  Cloudflare SFU grants, mediasoup credentials, or another media provider's
  access model.
- Media grants should not replace product authorization.

Recommended Media Plane grant claims:

- `iss`: Chalk issuer or media provider issuer.
- `aud`: Media Plane or provider audience.
- `sub`: participant or caller subject.
- `jti`: unique token ID for audit/revocation if needed.
- `iat`, `nbf`, `exp`: issued-at, not-before, and expiry.
- `org_id`: organization boundary.
- `room_id`: room scope.
- `session_id`: active session scope.
- `participant_id`: Chalk participant identity.
- `external_user_id`: customer-supplied user identity when available.
- `role`: product role.
- `media_scopes`: allowed media actions such as `audio:publish`,
  `video:publish`, `screen:publish`, `data:publish`, `media:subscribe`, or
  `recording:control`.
- `provider_room_id` or `provider_session_id`: provider-specific target when
  needed.
- `region`: optional routing or locality hint.

### Protocol Message

A versioned message sent between the SDK and the WebSocket Plane.

Owned by: Shared protocol contract

State category: Contract

Notes:

- Protocol messages define the wire-level shape of the sync system.
- The SDK encodes and decodes protocol messages.
- The WebSocket Plane validates and applies protocol messages.
- Protocol messages should be versioned before multiple SDK versions need to
  coexist.

### Sync Event

A meaningful live event produced by the WebSocket Plane and delivered to SDK
clients.

Owned by: WebSocket Plane + shared protocol contract

State category: Live, optionally projected durably

Notes:

- Sync events are the output of server-side live state transitions.
- Some sync events may also become durable events, analytics events, or webhook
  triggers, but that should be explicit.

### Live Room State

The authoritative in-memory or near-real-time state for an active room/session.

Owned by: WebSocket Plane

State category: Live

Notes:

- Live room state may include connected participants, presence, subscriptions,
  cursors, transient collaboration state, and ordering state.
- Durable snapshots or projections may be written elsewhere, but live room state
  is owned by the WebSocket Plane while active.

### Sync Cursor

A marker used to resume, replay, or reconcile live sync after reconnects.

Owned by: WebSocket Plane + shared protocol contract

State category: Live or projection

Notes:

- Sync cursors help SDK clients recover after disconnects.
- Cursor semantics should be protocol-level, not incidental implementation
  details.

### Durable Event

A recorded product event that survives process restarts and can drive webhooks,
audit logs, analytics, or projections.

Owned by: HTTP API / Control Plane or supporting workers

State category: Durable

Notes:

- Durable events are different from transient sync events.
- A sync event should become a durable event only when the product needs that
  history.

Candidate durable product and replay timeline events:

- `room.created`
- `room.updated`
- `room.archived`
- `session.started`
- `session.ended`
- `session.failed`
- `participant.joined`
- `participant.left`
- `participant.role_changed`
- `participant.metadata_updated`
- `presence.online`
- `presence.offline`
- `presence.updated`
- `presence.snapshot`
- `connection.opened`
- `connection.closed`
- `connection.resumed`
- `connection.resume_failed`
- `capability.issued`
- `capability.revoked`
- `media.session_started`
- `media.session_ended`
- `media.track_published`
- `media.track_unpublished`
- `media.track_muted`
- `media.track_unmuted`
- `recording.started`
- `recording.completed`
- `recording.failed`
- `webhook.delivery_scheduled`
- `webhook.delivery_succeeded`
- `webhook.delivery_failed`

Likely internal replay/diagnostic events, not necessarily customer-facing
webhook events by default:

- `sync.message_received`
- `sync.message_rejected`
- `heartbeat.missed`
- `backpressure.applied`

High-volume replay candidates that may need sampling, coalescing, or periodic
snapshots instead of one durable row per raw event:

- cursor movement
- selection changes
- typing indicators
- transient speaking/activity indicators
- per-message acknowledgements
- heartbeats

### Webhook Event

An externally delivered durable event for customer integrations.

Owned by: HTTP API / Control Plane

State category: Durable delivery workflow

Notes:

- Webhook events should be derived from durable product events, not raw live
  socket traffic.
- Delivery retries, signatures, and customer-facing payload compatibility belong
  to the HTTP API / Control Plane area.

## Important Distinctions

### Participant vs Connection

A participant is a product identity. A connection is a single live socket.

```text
Participant A
  -> Connection from laptop tab
  -> Connection from phone
  -> Reconnected connection after network loss
```

Product permissions should attach to the participant or issued capability.
Backpressure, heartbeats, and socket lifecycle should attach to the connection.

### Room vs Session

A room is the durable product container. A session is an active or historical
occurrence inside that container.

Chosen semantics:

- One room can host many sessions over time.
- One room can have multiple active sessions at the same time.
- Sessions should be explicit Control Plane entities, with SDK helpers for
  get-or-create/simple join flows.

This means session identity must be explicit enough that the SDK, WebSocket
Plane, Media Plane, recordings, and replay timeline all agree which session an
event belongs to.

The explicit session lifecycle tradeoffs are captured in
[chalk-session-lifecycle-2026-05-15.md](chalk-session-lifecycle-2026-05-15.md).

### Participant Identity

Participant identity means the identity shape Chalk exposes to customer apps and
SDK consumers.

Recommended shape:

- `participant_id`: Chalk-scoped participant ID.
- `external_user_id`: optional stable user ID supplied by the customer app.
- `display_name`, `avatar_url`, and `metadata`: optional profile fields.
- `role`: product role for the room/session.
- `capabilities`: effective actions granted for this participant.

Chalk should avoid making `connection_id` the app-facing identity. A connection
is one socket. A participant is the user-like product identity that may survive
reconnects and multiple devices.

Examples of first-class profile fields:

- `display_name`: shown in participant lists, replay, and generated events.
- `avatar_url`: shown in participant UI and replay.
- `role`: used for permissions and visible role display.
- `color` or `accent_color`: useful for cursors, whiteboard identity, or replay.
- `timezone` or `locale`: useful only if Chalk has time/localized UX needs.

Examples of opaque customer metadata:

- `team_id`
- `department`
- `plan`
- `crm_contact_id`
- `custom_avatar_variant`
- `experiment_bucket`
- `customer_internal_flags`

Rule of thumb:

```text
If Chalk needs to understand, render, query, or authorize with the field, make
it first-class. If Chalk only stores and echoes it for the customer app, keep it
inside metadata.
```

### Capability vs Permission

A permission is a product-level rule. A capability is a short-lived grant derived
from those rules.

```text
Permission: user X may join room Y as presenter.
Capability: signed token allowing this SDK client to connect to room Y as
presenter until 10:15.
```

The HTTP API / Control Plane owns permission decisions. The WebSocket and Media
Planes verify capabilities.

### Sync Event vs Durable Event

A sync event is for live clients. A durable event is product history.

```text
Sync event: participant cursor moved.
Durable event: session ended.
```

Not every live sync event should become durable.

### Room Authority vs Gateway/Fanout

A gateway accepts sockets, authenticates connections, validates basic protocol
shape, and routes messages. A fanout layer broadcasts events to subscribed
connections.

Room-local authority means the WebSocket Plane owns a server-side state machine
for an active room/session. That authority can assign sequence numbers, apply
live commands, enforce room-local invariants, track presence/subscriptions,
manage replay/resume cursors, and decide the resulting sync events.

```text
Gateway/fanout only:
client message -> validate envelope -> broadcast or forward

Room-local authority:
client command -> validate -> apply to live room state -> emit ordered events
```

Recommendation: Chalk probably needs at least lightweight room-local authority
inside the WebSocket Plane for presence, ordering, subscriptions, backpressure,
and reconnect/resume. It should still leave product policy and durable lifecycle
decisions to the HTTP API / Control Plane.

## Open Questions

- Which live sync events should become durable product events?
- Which durable timeline events should also become customer-facing webhook
  events?
- What retention policy should replay timeline events use?
- How often should `presence.snapshot` be captured during long sessions?
- Which participant profile fields are first-class versus opaque customer
  metadata?
