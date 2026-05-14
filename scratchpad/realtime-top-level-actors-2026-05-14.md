# Chalk Realtime Top-Level Actors

Date: 2026-05-14

This note defines Chalk's top-level architecture actors and their primary
responsibilities. Lower-level systems such as persistence, queues, workers, and
observability are important implementation infrastructure, but they are not
counted here as top-level product/runtime actors.

## 1. SDK

The SDK is the developer-facing client surface for Chalk.

Responsibilities:

- Provide the public client API used by application developers.
- Manage client-side room/session state.
- Talk to the HTTP API for control-plane operations such as creating or joining
  rooms and fetching capability tokens.
- Connect to the WebSocket Plane for realtime sync.
- Connect to the Media Plane for audio/video/data transport when applicable.
- Implement client-side reconnect, resume, retry, and local state recovery.
- Own the client-side half of Chalk's realtime sync behavior.
- Hide protocol and infrastructure complexity behind stable developer-facing
  abstractions.

The SDK is tightly coupled to the WebSocket Plane through a formal realtime
protocol contract, not through informal duplicated logic.

## 2. HTTP API / Control Plane

The HTTP API is the product and policy authority.

Responsibilities:

- Authenticate users, projects, apps, or server-side callers.
- Authorize durable product actions such as creating rooms, joining sessions,
  issuing tokens, configuring projects, and handling webhooks.
- Own product-level rules such as permissions, entitlements, lifecycle policy,
  billing-related gates, and durable state transitions.
- Issue short-lived capability tokens for WebSocket and Media Plane access.
- Expose stable HTTP APIs for SDKs, dashboards, integrations, and internal
  services.
- Persist durable product state and emit events when other planes need to react.

The HTTP API decides who may do something. It should not own long-lived
connection mechanics, realtime fanout, or media transport.

## 3. WebSocket Plane

The WebSocket Plane owns realtime client connectivity and live room/session sync.

Responsibilities:

- Accept and manage long-lived WebSocket connections.
- Verify capability tokens issued by the HTTP API.
- Enforce protocol-level invariants such as message shape, version, max payload
  size, authentication-before-subscribe, and rate limits.
- Manage connection lifecycle: heartbeat, reconnect, resume, draining, and slow
  client handling.
- Maintain live room/session state where needed.
- Own presence, subscriptions, message ordering, fanout, and backpressure.
- Host the server-side half of Chalk's realtime sync engine.
- Emit events or state changes for persistence, projections, analytics, or
  control-plane workflows when durable state needs to change.

The WebSocket Plane decides what is true right now inside a live room/session.
It should not independently reimplement product policy owned by the HTTP API.

Internal distinction:

- Gateway layer: how clients connect, authenticate, send, and receive messages.
- Sync engine: what the live room/session state is and how it changes.

## 4. Media Plane

The Media Plane owns low-latency audio, video, and media/data transport.

Responsibilities:

- Handle realtime media transport paths.
- Integrate with Cloudflare RealtimeKit, Cloudflare SFU, mediasoup, or other media infrastructure.
- Keep media latency, reliability, and quality concerns separate from product
  control-plane logic.
- Accept only access grants or tokens authorized by the HTTP API.
- Surface media/session events back to Chalk when product state or observability
  needs to react.

The Media Plane moves media. It should not own product authorization, billing,
room lifecycle policy, or SDK-facing product abstractions.

## Cross-Cutting Realtime Sync System

Chalk's realtime sync system crosses actor boundaries:

- SDK: client-side sync runtime.
- WebSocket protocol: shared versioned contract.
- WebSocket Plane: server-side sync runtime and live room/session authority.

The SDK and WebSocket Plane are two halves of Chalk's realtime sync system,
connected by a versioned WebSocket protocol.

Shared contract should include:

- Protocol message schemas.
- Capability token claims.
- Room/session event types.
- Versioning and compatibility rules.
- Error shapes and close codes.

## Summary

The HTTP API decides who may do something; the WebSocket Plane decides what is
true right now inside a live room/session; the Media Plane moves media; the SDK
makes the whole system feel simple to application developers.
