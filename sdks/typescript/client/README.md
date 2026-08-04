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

Your backend mints an `AccessGrant` with the server SDK. Pass it through to the
client unchanged: it is an opaque signed envelope, so application code does
not construct or inspect it.

```ts
import { createSpaceClient, type AccessGrant } from "@q9labsai/chalk-client";

const client = createSpaceClient({
  space: "design-review",
  getAccess: async ({ space, reason }): Promise<AccessGrant> => {
    const response = await fetch(`/api/chalk/spaces/${space}/access?reason=${reason}`);
    if (!response.ok) throw new Error("Could not get access");
    return response.json() as Promise<AccessGrant>;
  },
});

await client.join({
  displayName: "Ari",
  microphone: true,
  camera: false,
});
```

`getAccess` receives `reason: "join" | "refresh" | "retry"`. `Connection`
uses it for pre-join freshness, scheduled refresh, wake revalidation, and one
refresh-and-retry after an access rejection. Keep the callback available for
the full lifetime of the client.

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
const url = client.chat.files.url(attachment);

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

## Effect entry

The default entry is Promise-based. Effect applications can use the
`@q9labsai/chalk-client/effect` entry for the same `SpaceClient` shape as an
Effect program.
