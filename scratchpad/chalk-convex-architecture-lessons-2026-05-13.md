# Chalk Convex Architecture Lessons

Date: 2026-05-13

Context: Early Chalk redesign prep. The goal is to learn from Convex's system
design and architecture taste, not to adopt Convex and not to focus on Convex's
database product. Transcripts were pulled with `yt-dlp` into
`/tmp/chalk-convex-transcripts/normalized`. Fifteen caption-backed transcripts
were normalized successfully. Three no-caption videos were downloaded as audio
under `/tmp/chalk-convex-transcripts/audio`; local Whisper was attempted with
`base.en` but produced no transcript output in a practical window, so this note
is based on the caption-backed corpus.

## What To Copy

### Design around coherent product state

Convex repeatedly frames backend work as state management, not storage
plumbing. For Chalk, the central question is not "what tables exist?" but:

- what does each participant believe is happening in the room?
- what does the host UI believe?
- what do recording, transcript, webhook, support, billing, and SDK consumers
  believe?
- can those views disagree in ways users can notice?

Chalk should model room/session state as a coherent product object with an
explicit lifecycle, not as scattered API responses and socket events.

### Use one authoritative commit path

Keep durable shared decisions server-owned: room admission, roles, moderation,
recording, transcript state, billing-visible usage, webhook-worthy events, and
room lifecycle. Clients can optimistically render local UX, but every action
needs a clear commit point and reconciliation story.

Good Chalk shape:

```text
client command -> authoritative control plane commit -> ordered room revision
               -> materialized state -> SDK reactive view + webhooks
```

### Treat realtime as derived state

Avoid raw pub/sub sprawl where every subsystem emits unrelated events directly
to clients. Prefer committed events plus materialized projections:

- append-only `session_events`
- room snapshot
- participant snapshot
- track snapshot
- recording/transcript snapshot
- moderation snapshot

Clients should consume ordered revisions or snapshots, not manually reconcile a
pile of racing topics.

### Split realtime into durability lanes

Not all realtime belongs in the same machinery.

```text
Durable control:
  room lifecycle, participant membership, roles, permissions, recording,
  transcript status, webhook events, billing usage

Soft realtime:
  presence, hand raise, reactions, chat state, active speaker, device state

Ephemeral media telemetry:
  audio levels, packet loss, jitter, bitrate, ICE/RTC stats
```

The durable lane should be correct and replayable. The soft lane can be
ordered enough for UX. The telemetry lane should be sampled, streamed,
aggregated, and expired.

### Preserve consistent client views

A room UI should not briefly show impossible combinations such as a removed
participant with active host controls, or a recording state that disagrees with
webhook-visible state. The SDK should expose one coherent room store with
selectors, not disconnected event handlers.

Example selectors:

```ts
room.participants
room.localParticipant.permissions
room.tracksByParticipant
room.recording.status
room.connection.health
```

### Make platform APIs feel like library APIs

Convex's strongest product taste is that platform complexity is hidden behind
developer-shaped APIs. Chalk should expose domain commands and typed state,
while SDK internals handle reconnects, token refresh, retries, ordering, gap
recovery, and RealtimeKit edge cases.

Example command shape:

```ts
joinRoom({ roomId, token, clientRequestId })
setLocalTrackPublished({ trackId, kind, desiredState, clientRequestId })
setParticipantRole({ participantId, role, revisionPrecondition, clientRequestId })
startRecording({ roomId, clientRequestId })
```

### Make commands idempotent and side effects event-driven

Control-plane commands should be safe to retry. External effects should be
driven from committed events with idempotency keys:

- Cloudflare RealtimeKit calls
- webhooks
- storage writes
- transcript jobs
- billing/usage increments
- emails or notifications

This keeps retry behavior understandable and prevents mobile reconnects from
creating duplicate product actions.

### Design for room contention

Rooms are natural contention domains. A two-person call hides problems that a
large class, webinar, or support room will expose. Avoid one hot room row or
one global lock for all joins, leaves, tracks, chat, telemetry, and recording
state.

Separate frequently written state from stable metadata. Use event logs,
projections, sharded counters, or separate lanes where the write pattern calls
for it.

### Version protocols like public APIs

Mobile SDKs and customer integrations mean "deploy both sides" is not a real
strategy. Control-plane events, webhooks, SDK state, and websocket messages
need additive schemas, version negotiation, compatibility windows, canaries,
and rollback plans.

## Chalk Design Implications

1. Model Chalk's control plane as committed room/session events plus
   materialized projections.
2. Give each client a monotonic room revision and a reconnect protocol:
   `lastSeenRevision -> missed events or fresh snapshot`.
3. Keep Cloudflare RealtimeKit as media/data-plane capability, not Chalk's
   whole source of truth.
4. Let SDK packages own session lifecycle, room state, recovery, diagnostics,
   and command idempotency.
5. Keep apps thin: visual shell, configuration, and verification flows.
6. Use generated contracts for REST, websocket/control events, SDK models, and
   webhook payloads.
7. Build debugging around user-visible state transitions:
   "join committed?", "track accepted?", "revision delivered?", "client gap?",
   "UI suppressed stale state?", "RealtimeKit rejected intent?"

## Anti-Patterns To Avoid

- Raw pub/sub from many services directly to clients.
- Client authority over shared room state.
- Persisting every high-frequency media signal.
- One hot `rooms.current_state` record that every update rewrites.
- SDK event-handler soup where customers manually compose room truth.
- Deploys that assume every SDK/client updates immediately.
- Letting RealtimeKit implementation details become Chalk's product contract.
- Treating docs or demo apps as the contract when packages and generated
  schemas should own behavior.

## Best Videos To Watch First

1. `Sync Protocols and the Truth Behind Local-First`
   Source-of-truth thinking, optimistic UX, conflict design, and sync tradeoffs.
2. `Data Interactivity in the Serverless Future`
   Global state, subscriptions, dependency tracking, and consistent client
   views.
3. `Backends Should be Designed for Product Developers`
   Platform API taste, abstraction boundaries, typed APIs, and developer
   experience.
4. `Streaming vs. Syncing: Why Your Chat App Is Burning Bandwidth`
   How to separate streamed active state from durable replicated state.
5. `How Convex Works - A Technical Deep Dive`
   Concrete architecture loop: commit log, read/write sets, subscription
   manager, WebSocket sync worker, function runner.
6. `What ACTUALLY happens when you push to Convex?`
   Deployment architecture, isolation, versioning, caches, committers, limits,
   and operational safety.

## Open Redesign Questions

- What exact events belong in Chalk's durable control lane?
- Which soft realtime states should be persisted, TTL-backed, or purely
  streamed?
- Does Chalk need an append-only room event log in the primary API store, a
  dedicated event store, or a room-scoped realtime authority?
- Should websocket/session control live in Go, TypeScript, Cloudflare Durable
  Objects, or a hybrid?
- What is the SDK contract for coherent room snapshots and revision resume?
- How will old mobile SDKs negotiate protocol compatibility?
- Which actions can be optimistic, and which must wait for server acceptance?
- What should support/debug tooling show for a failed join or missing video
  tile?
