# Realtime API Architecture Inspiration

Date: 2026-05-13

Context: We were deciding whether Chalk should keep the API in Go, migrate the
HTTP/control-plane API to TypeScript + EffectTS, and potentially keep a Go
WebSocket service for the hot connection path. The main concern was whether a
hybrid design is smart or just duplication waiting to happen.

## Useful Public References

### Slack: API plus realtime messaging tier

Slack separates normal API/Webapp work from realtime WebSocket delivery. Clients
can send mutations through HTTP/API paths while persistent socket infrastructure
delivers events back to connected clients.

Source: https://slack.engineering/real-time-messaging/

Useful mental model:

```text
Client
  |-- HTTP mutation --> API/Webapp --> DB
  |                         |
  |                         v
  |                    realtime routing
  |                         |
  |-- WebSocket <------ gateway/channel tier
```

### Figma: realtime ownership scoped by collaborative object

Figma's multiplayer architecture is useful because it scopes realtime ownership
around a file/document. The important design lesson is not the exact technology,
but the ownership model: one realtime authority for one collaborative object.

Sources:

- https://www.figma.com/blog/how-figmas-multiplayer-technology-works/
- https://www.figma.com/blog/under-the-hood-of-figmas-infrastructure/

Useful mental model:

```text
Client A ----\
              > WebSocket --> multiplayer instance for File X --> persistence
Client B ----/
```

### Cloudflare Durable Objects: one stateful object per room/session

Durable Objects are relevant to Chalk because they provide a natural "one object
owns one room/session" shape, including WebSocket support and hibernation.

Sources:

- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/

Useful mental model:

```text
Client --> Worker/API --> Durable Object: room:{id}
                      --> WebSocket clients
                      --> room-local state/storage
```

### Discord: use different languages for different jobs

Discord is a good confidence reference because it has used different languages
and storage systems for different pressure points. The lesson is that a large
system is not invalid because it is not one runtime. Product logic, transport
hot paths, storage, and media paths can be separated.

Sources:

- https://medium.com/discord-engineering/how-discord-stores-billions-of-messages-7fa6ec7ee4c7
- https://www.scylladb.com/tech-talk/how-discord-migrated-trillions-of-messages-from-cassandra-to-scylladb/

Useful principle:

```text
Use the productive language for product/control-plane logic.
Use specialized services only where scale or latency proves the need.
```

### Linear: realtime sync as its own subsystem

Linear is a reminder that realtime sync often becomes a real product primitive,
not just "some WebSockets" bolted onto an API.

Source: https://linear.app/blog/scaling-the-linear-sync-engine

### Liveblocks: room-based collaboration vocabulary

Liveblocks is useful for concepts even if Chalk does not use it: rooms,
presence, low-latency messaging, connection lifecycle, and multiplayer
coordination.

Sources:

- https://liveblocks.io/docs/concepts
- https://liveblocks.io/blog/why-websocket-gets-hard-in-multiplayer-apps

## Recommended Chalk Direction To Explore

The hybrid architecture is smart if the boundary is clean:

```text
                +----------------------+
Client -------->| TypeScript API       |
HTTP            | EffectTS             |
                | auth, rooms, tokens  |
                | billing, webhooks    |
                +----------+-----------+
                           |
                           | signed capability token
                           v
                +----------------------+
Client -------->| Go WebSocket Gateway |
WebSocket       | connections, fanout  |
                | presence, heartbeat  |
                | backpressure         |
                +----------+-----------+
                           |
                           v
                +----------------------+
                | Redis/NATS/Postgres  |
                | events/projections   |
                +----------------------+

Cloudflare RealtimeKit remains the media/data-plane.
```

Rule of thumb:

- TypeScript + EffectTS owns product decisions.
- Go owns hot transport and connection mechanics.
- Cloudflare RealtimeKit owns the media/data-plane.

## Duplication Boundary

Acceptable duplication in Go:

- JWT/session structural verification
- room ID and message shape checks
- max payload size
- protocol version checks
- rate limiting
- heartbeat timeouts
- backpressure and slow-client handling
- "authenticated before subscribe"
- generated protocol schema validation

Bad duplication in Go:

- billing or entitlement decisions
- organization/team permission logic
- product-specific room lifecycle policy
- DB write workflows already owned by the API
- independently reimplemented business rules

When Go needs a product decision, prefer one of these:

- Ask an internal TypeScript API endpoint.
- Verify a short-lived signed capability token minted by the TypeScript API.
- Consume a simplified state projection from Redis/NATS/Postgres.
- Use generated contracts for schemas, protocol messages, and error shapes.

Favorite flow:

```text
1. Client asks TS API to create/join a room.
2. TS checks auth/org/permissions/billing/etc.
3. TS returns RealtimeKit token plus Chalk WebSocket capability token.
4. Client connects to Go WebSocket with the capability token.
5. Go verifies the token and handles realtime transport.
6. Go emits events; TS consumes only when durable product state matters.
```

## Architecture Variants To Diagram Later

1. Hybrid TypeScript + EffectTS API with Go WebSocket Gateway.
2. All TypeScript + EffectTS API and WebSocket service.
3. Cloudflare Durable Object per room/session.

Compare each variant on:

- ownership confidence
- duplication risk
- p95 latency
- concurrent connection capacity
- memory per connection
- deploy/draining complexity
- schema and contract sharing
- operational debugging
- ability to keep RealtimeKit as the media/data-plane
