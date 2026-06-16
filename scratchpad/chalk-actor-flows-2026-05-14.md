# Chalk Actor Flows

Date: 2026-05-14

## TLDR

The SDK asks the HTTP API / Control Plane for capabilities, then uses those
capabilities to connect to the WebSocket and Media Planes. The WebSocket Plane
owns live sync after connection, while the HTTP API remains the durable product
authority.

This note builds on
[chalk-top-level-actors-2026-05-14.md](chalk-top-level-actors-2026-05-14.md)
by describing the main flows between Chalk's top-level actors. Actor
definitions, responsibilities, and boundary principles live in that note.

## Flow 1: Create Or Join A Room

```text
SDK
  -> HTTP API / Control Plane
      -> authenticate caller
      -> authorize create/join action
      -> create or load durable room/session state
      -> issue WebSocket capability token
      -> issue Media Plane access token when needed
  <- SDK
```

Ownership:

- HTTP API decides whether the caller may create or join.
- HTTP API defines the durable room/session policy.
- SDK receives only the capabilities it needs to proceed.
- WebSocket Plane and Media Plane do not independently recalculate product
  permissions.

## Flow 2: Connect To The WebSocket Plane

```text
SDK
  -> WebSocket Plane
      -> verify WebSocket capability token
      -> validate protocol version
      -> accept connection
      -> attach connection to room/session scope
      -> begin heartbeat, resume, and backpressure handling
  <- SDK
```

Ownership:

- SDK owns client-side connection lifecycle.
- WebSocket Plane owns server-side connection lifecycle.
- HTTP API is not on the hot path after it issues the capability token.
- Capability token claims are the bridge between product policy and live
  connection enforcement.

## Flow 3: Live Sync Message

```text
SDK client-side sync runtime
  -> WebSocket protocol message
  -> WebSocket Plane
      -> validate message shape and version
      -> check capability claims and room/session scope
      -> apply server-side sync rules
      -> update live room/session state
      -> fan out resulting events
  -> SDK clients
```

Ownership:

- SDK owns local state, optimistic behavior, and developer-facing callbacks.
- WebSocket Plane owns live room/session truth.
- Shared protocol contract owns message schemas, event types, close codes, and
  compatibility rules.
- HTTP API is involved only when durable product state or product policy must
  change.

## Flow 4: Connect To The Media Plane

```text
SDK
  -> Media Plane
      -> verify media access token or grant
      -> establish audio/video/data transport
      -> emit media/session events when needed
  <- SDK
```

Ownership:

- HTTP API authorizes media access by issuing the token or grant.
- Media Plane owns transport quality, latency, and reliability.
- SDK owns client media setup and developer-facing media abstractions.
- WebSocket Plane may coordinate room/session sync around media state, but it
  does not move media itself.

## Flow 5: Durable State Change From Live Activity

```text
WebSocket Plane
  -> event/projection/supporting infrastructure
  -> HTTP API / Control Plane or worker
      -> validate durable state transition if needed
      -> persist product state
      -> emit follow-up events
```

Ownership:

- WebSocket Plane may observe live activity and emit events.
- HTTP API / Control Plane remains the authority for durable product state
  transitions.
- Supporting infrastructure carries events; it does not become a product
  authority.

## Flow 6: Disconnect, Resume, Or Reconnect

```text
SDK
  -> WebSocket Plane
      -> detect disconnect or resume attempt
      -> validate resume token/cursor when applicable
      -> restore connection to room/session scope
      -> replay or resync supported state
  <- SDK
```

Ownership:

- SDK owns retry strategy and local recovery behavior.
- WebSocket Plane owns whether a connection can resume and what live state is
  replayed or resynced.
- Protocol contract defines resume tokens, cursors, and compatibility.

## Decision Boundaries

| Question                                             | Owner                          |
| ---------------------------------------------------- | ------------------------------ |
| May this user/app/org create or join this room?      | HTTP API / Control Plane       |
| What capabilities does this client have?             | HTTP API / Control Plane       |
| What is true inside the live room/session right now? | WebSocket Plane                |
| What durable product state should change?            | HTTP API / Control Plane       |
| How does the client recover after disconnect?        | SDK + WebSocket Plane protocol |
