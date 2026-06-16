# Chalk Session Lifecycle

Date: 2026-05-15

## TLDR

Chalk should treat sessions as explicit Control Plane entities, while the SDK
can provide ergonomic helpers that make the common case feel automatic. This
keeps recording, replay, media, billing, analytics, and multi-session rooms
unambiguous without forcing app developers to hand-roll ceremony for simple
flows.

Related notes:

- [chalk-top-level-actors-2026-05-14.md](chalk-top-level-actors-2026-05-14.md)
- [chalk-actor-flows-2026-05-14.md](chalk-actor-flows-2026-05-14.md)
- [chalk-domain-model-2026-05-14.md](chalk-domain-model-2026-05-14.md)

## Chosen Direction

Control Plane model:

```text
Rooms can have many sessions over time.
Rooms can have multiple active sessions at the same time.
Sessions are explicit durable entities.
Every live/replay/media event belongs to a specific session.
```

SDK ergonomics:

```text
The SDK can expose helpers that create, fetch, or join sessions without making
simple apps think about every lifecycle step.
```

This gives Chalk a precise backend model and a friendly client model.

## Why Explicit Sessions

Explicit sessions are the better source-of-truth model because Chalk wants
immersive session replay.

Replay needs a stable `session_id` that can join together:

- WebSocket timeline events.
- Participant lifecycle events.
- Presence changes.
- Connection lifecycle events.
- Media tracks and provider session IDs.
- Recording segments.
- Sync snapshots and cursors.
- Analytics and billing aggregates.

If session creation is hidden behind first join, those timelines become easier
to blur, especially when a room can have multiple active sessions.

## Explicit Session Creation

Example shape:

```text
POST /rooms/:roomId/sessions
POST /sessions/:sessionId/join
```

Upsides:

- Clear `session_id` before WebSocket, media, recording, and replay begin.
- Works naturally when one room has multiple active sessions.
- Makes lifecycle events intentional: `session.started`, `session.ended`,
  `recording.started`, `recording.completed`.
- Easier billing, analytics, webhooks, and replay stitching.
- Easier customer debugging because sessions exist for an explicit reason.

Downsides:

- More ceremony for simple apps.
- Customer apps or SDK helpers need to understand lifecycle.
- Abandoned sessions need cleanup, timeout, and end-state rules.

## Implicit Session Creation

Example shape:

```text
room.join()
```

The first join creates a session if needed.

Upsides:

- Very ergonomic.
- Fewer API calls.
- Great for demos, prototypes, and simple rooms.
- The common path can "just work."

Downsides:

- Ambiguous when rooms can have multiple active sessions.
- Session lifecycle becomes a hidden side effect of joining.
- Recording and replay may start at surprising times.
- Race conditions around first join need careful handling.
- Analytics, billing, and webhooks become less intentional.

## Recommended SDK Shape

Expose explicit primitives:

```ts
const room = await chalk.rooms.get(roomId);
const session = await room.createSession();
await session.join();
```

Expose ergonomic helpers:

```ts
const session = await room.getOrCreateSession({ key: "main" });
await session.join();
```

Potential one-liner for simple apps:

```ts
const session = await chalk.joinRoom(roomId, {
  session: { getOrCreate: "main" },
});
```

The helper should still return a real `session_id`.

## Session Keys

If the SDK supports get-or-create behavior, it should probably use a customer
or SDK-provided session key.

Examples:

- `main`
- `whiteboard`
- `support-call-123`
- `breakout-a`

The Control Plane can enforce:

```text
room_id + session_key -> active session
```

This allows ergonomic joins while avoiding accidental duplicate active sessions
for the same logical use case.

## Cleanup Rules

Explicit sessions need lifecycle cleanup rules.

Candidates:

- End session when the app calls `endSession`.
- End session after no participants are present for a configured timeout.
- End session after media has been inactive for a configured timeout.
- Mark abandoned sessions separately from normally ended sessions.
- Keep replay timeline and recording finalization idempotent.

## Open Questions

- Should `session_key` be first-class, optional, or only an SDK helper concept?
- What is the default inactivity timeout for ending a session?
- Can customers manually end a session while participants are still connected?
- Should a room have a default session policy, such as `single-main-session` or
  `multi-session`?
- Which session lifecycle events become customer-facing webhooks?
