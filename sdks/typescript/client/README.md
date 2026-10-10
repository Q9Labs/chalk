# @q9labsai/chalk-client

`@q9labsai/chalk-client` is Chalk's framework-agnostic `SpaceClient`. It
connects a person to a Space, maintains the live Episode, and exposes one
consistent `SpaceSnapshot` for any UI layer.

A Space is the durable place for collaboration: its identity, configuration,
members, and living content persist between Episodes. An Episode is one bounded
run of live activity in that Space. `join()` always targets the Space; an
Episode emerges when appropriate.

## Install

```sh
pnpm add @q9labsai/chalk-client
```

## Create and join a Space

Your backend mints an `AccessGrant` with the server SDK. See the [web quickstart](../../../docs/sdk-web-quickstart.md) for Tenant setup, `createChalkServerClient`, Space creation, Participant admission, and server-only `getAccessRefreshState` for normal access refresh. Pass it through to the
client unchanged: it is an opaque signed envelope, so application code does
not construct or inspect it. `getAccess` may resolve with the fetch `Response`
that carries the grant or with its decoded JSON; the client validates it and
fails the join on a non-OK response or a malformed body.

```ts
import { createSpaceClient } from "@q9labsai/chalk-client";

const client = createSpaceClient({
  space: "design-review",
  getAccess: ({ space, reason, replaceMediaConnection }) =>
    fetch("/api/chalk/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space, reason, replaceMediaConnection }),
    }),
});

await client.join({
  displayName: "Ari",
  microphone: true,
  camera: false,
});
```

`getAccess` receives `reason: "join" | "refresh" | "retry"`. `Connection`
uses it for Entrance freshness, scheduled refresh, wake revalidation, and one
refresh-and-retry after an access rejection. Keep the callback available for
the full lifetime of the client. Forward `replaceMediaConnection` to your backend:
media recovery needs a fresh connection when it is `true`; ordinary refresh
retains the current binding when it is `false`. The quickstart shows both paths.

## Snapshot store

`subscribe` and `getSnapshot` form a framework-neutral external-store contract.
Each snapshot has referentially stable slices, so UI code can select only the
state it needs.

```ts
const unsubscribe = client.subscribe(() => {
  const snapshot = client.getSnapshot();
  renderConnection(snapshot.connection.status);
});

const snapshot = client.getSnapshot();
if (snapshot.self.can("sendChat")) {
  await client.chat.send({ text: "Ready when you are." });
}

unsubscribe();
```

`SpaceSnapshot` contains these slices:

- `connection`: status, live Episode summary, and the latest failure
- `self`: local Participant identity, role, capabilities, hand state, and `can(capability)`
- `participants`: roster and admission queue
- `media`: device selection, local and remote media, screen share, and requests
- `chat`: messages, pending sends, read receipts, unread count, and pagination
- `reactions`: active transient reactions
- `whiteboard`: availability and engine state

## Lifecycle and Episode controls

```ts
await client.leave();
await client.endEpisode();
await client.extendEpisode(15);
client.dispose();
```

`endEpisode` and `extendEpisode` are capability-gated. Use `dispose()` when
the client will no longer be used; it releases the Connection and its resources.

## Feedback

`SpaceClient.feedback` submits a bug, feature request, or other feedback
report to Chalk with the current safe diagnostic context. `prepare` gives a
form one stable idempotency key and captures evidence before the user sends it.

```ts
const feedback = await client.feedback.prepare();

await feedback.send({
  category: "bug",
  message: "The camera control stopped responding.",
});
```

The transport uses the short-lived Diagnostic Participant credential already
carried by the AccessGrant. That credential is never exposed through the public
Feedback API. Custom screenshot adapters may be passed to `prepare`; a typed
unavailable result is valid and never blocks a text report.

## Recording and artifact Events

Use `client.recording.start()` and `client.recording.stop()` inside an Episode, or set the Space's Automatic Recording policy. There is no REST Recording start/stop operation.

The server SDK requests Exports and creates download URLs. Subscribe to `recording.completed` for verified MP4 readiness and `transcript.completed` for document readiness; both also emit `started` and `failed`. See the [webhook guide](docs/webhooks.md).

## Feature controllers

Lifecycle stays flat on `SpaceClient`; feature commands are namespaced.

```ts
await client.media.setMicrophoneEnabled(true);
await client.media.setCameraEnabled(true);
await client.media.setScreenShareEnabled(true);
await client.media.selectMicrophone("microphone-id");
await client.media.selectCamera("camera-id");
await client.media.selectSpeaker("speaker-id");
await client.media.acceptRequest("request-id");
await client.media.declineRequest("request-id");

await client.chat.send({ text: "Hello" });
await client.chat.loadOlder();
await client.chat.markRead("message-id");
const attachment = await client.chat.files.upload(file);
const url = await client.chat.files.resolveUrl(attachment);

await client.participants.assignRole("participant-id", "collaborator");
await client.participants.mute("participant-id");
await client.participants.stopVideo("participant-id");
await client.participants.stopScreenShare("participant-id");
await client.participants.requestMedia("participant-id", "microphone");
await client.participants.remove("participant-id");
await client.participants.admit("request-id");
await client.participants.deny("request-id");
await client.participants.raiseHand();
await client.participants.lowerHand();
await client.participants.renameSelf("Ari");

// Chat messages and hand raises made while the connection recovers are held.
// The default policy sends them once live again. With "ask", read
// `client.getSnapshot().offline` and let the user decide.
await client.offline.setPolicy("ask"); // "ask" | "send" | "discard"
await client.offline.send(); // or client.offline.discard()

// Held actions survive a browser reload for up to 24 hours. They are restored
// only for the same tenant, Space, Episode, participant and generation.
// Restored actions ask for a decision unless a policy has been set explicitly.
// Expired or mismatched actions are dropped; snapshot.offline.notice explains why.
// Native consumers can pass offlineActionsStorage in createSpaceClient options:
// a synchronous getItem/setItem/removeItem adapter (for example, hydrated MMKV).
// If browser storage is unavailable, actions stay in memory and a notice asks
// the user to keep the page open. Stored actions are retired before dispatch;
// a crash in that small interval can lose an action, but cannot replay it.

await client.reactions.send("🎉");
const transport = client.whiteboard.transport();
```

## Events and failures

Use `on` for discrete events and snapshots for current state.

```ts
const stopListening = client.on("episodeEnded", ({ episode }) => {
  showEpisodeHistory(episode?.id);
});

client.on("error", ({ error }) => {
  reportSafeDiagnostic(error.code, error.recoverable);
});

stopListening();
```

Events are `participantJoined`, `participantLeft`, `episodeEnded`,
`screenShareStarted`, `screenShareStopped`, and `error`. Public failures use
stable codes such as `access.invalid`, `episode.ended`, and
`chat.payload_invalid`.

## Journey telemetry

Client telemetry is opt-in. Start a `space.join` journey when a Participant
joins a Space, pass its `context` to HTTP or Sync boundaries, and flush the
bounded queue when the surface is ready to export:

```ts
import { createTelemetryClient } from "@q9labsai/chalk-client/telemetry";

const telemetry = createTelemetryClient({ enabled: true, baseUrl: "https://api.example.com" });
const journey = telemetry.startJourney({ kind: "space.join" });
const response = await fetch("/api/chalk/spaces/design-review", { headers: journey.headers });
journey.terminal(response.ok ? "succeeded" : "failed");
await telemetry.flush();
```

Journey events carry `journey_id`, W3C `traceparent`, and optional
`tracestate`. Attributes and the in-memory timeline are bounded, and the
built-in client observations record aggregate RTC state only: access-grant
contents, Participant identity, Space or Episode identifiers, media payloads,
and request bodies stay out of telemetry.

## Effect entry

The default entry is Promise-based. Effect applications can use the
`@q9labsai/chalk-client/effect` entry for the same `SpaceClient` shape as an
Effect program.

## Sync v1 maintenance

- `V1SyncClient` owns the race-sensitive socket generation, connection phases,
  reconnect and heartbeat flow, recovery/revision evidence, projections, and
  snapshots.
- `V1CollaborationState` owns negotiated collaboration state, cursors,
  receipts, listeners, and chat/reaction deferreds.
- `V1CommandScheduler` owns durable command persistence and reconciliation,
  capacity, retries, timers, and settlement.
- `V1LiveTargetCoordinator` owns self-media target authorization, adapter
  execution, retries, deadlines, and local target state.
