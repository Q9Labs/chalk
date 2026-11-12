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

Your backend mints an `AccessGrant` with the server SDK. Use `createChalkServerClient` for Tenant setup, Space creation, Participant admission, and server-only `getAccessRefreshState` for normal access refresh. Pass it through to the
client unchanged: it is an opaque signed envelope, so application code does
not construct or inspect it. `getAccess` may resolve with the fetch `Response`
that carries the grant or with its decoded JSON; the client validates it and
classifies non-OK responses and rejects malformed bodies.

```ts
import { createSpaceClient } from "@q9labsai/chalk-client";

const client = createSpaceClient({
  space: "design-review",
  getAccess: (request) =>
    fetch("/api/chalk/access", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
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
the full lifetime of the client. Forward the request unchanged to your backend,
then pass it as the final `participants.issueAccess` argument alongside the
server-only state from `getAccessRefreshState`. Chalk selects media replacement
when recovery needs it and retains healthy media for ordinary refresh and Sync
recovery. The quickstart shows the endpoint call; no conditional is needed.

HTTP 408, 425, 429, and 5xx responses, network failures, and provider timeouts are `access.unavailable` (recoverable). Scheduled refresh retries these failures while retaining the current grant. Other non-OK responses (including 401 and 403) and malformed grants are `access.invalid`. Initial join does not automatically retry unavailable Access: show the failure and let the person check their network and try again. Return the `Response` unchanged so Chalk can classify its status; throwing a generic error for every non-OK response loses that distinction.

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

## Lifecycle and Episode controls

```ts
await client.leave();
await client.endEpisode();
await client.extendEpisode(15);
client.dispose();
```

`endEpisode` and `extendEpisode` are capability-gated. Use `dispose()` when
the client will no longer be used; it releases the Connection and its resources.

## Recording and artifact Events

Use `client.recording.start()` and `client.recording.stop()` inside an Episode, or set the Space's Automatic Recording policy. There is no REST Recording start/stop operation.

The server SDK requests Exports and creates download URLs. Subscribe to `recording.completed` for verified MP4 readiness and `transcript.completed` for document readiness; both also emit `started` and `failed`. See the [webhook guide](docs/webhooks.md).

## Feature controllers

Lifecycle stays flat on `SpaceClient`; feature commands are namespaced under `media`, `chat`, `participants`, `reactions`, `whiteboard`, `recording` and `offline`. Their methods are typed, so read the `SpaceClient` types for the full list.

```ts
await client.media.setMicrophoneEnabled(true);
await client.chat.send({ text: "Hello" });
await client.participants.raiseHand();
await client.reactions.send("🎉");
const transport = client.whiteboard.transport();
```

### Offline actions

Chat messages, message reactions and hand raises made while the connection recovers are held. The default policy sends them once live again. With `"ask"`, read `client.getSnapshot().offline` and let the user decide.

```ts
await client.offline.setPolicy("ask"); // "ask" | "send" | "discard"
await client.offline.send(); // or client.offline.discard()
```

Held actions survive a browser reload for up to 24 hours and restore only for the same tenant, Space, Episode, participant and generation. Restored actions ask for a decision unless a policy was set explicitly. Expired or mismatched actions are dropped, and `snapshot.offline.notice` says why. Native apps pass `offlineActionsStorage` to `createSpaceClient`: a synchronous `getItem`/`setItem`/`removeItem` adapter (for example, hydrated MMKV). Without storage, actions stay in memory. Stored actions are retired before dispatch, so a crash in that small interval can lose an action but never replays it.

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

Events are `participantJoined`, `participantLeft`, `episodeEnded`, `screenShareStarted`, `screenShareStopped`, and `error`. Public failure codes are stable. Keep a default branch for codes added later.

### Connection failures

`join()` rejections, `connection.lastError`, and `client.on("error")` use the same public codes and preserve `recoverable`. Recoverable does not mean joined: a failed startup needs another `join()`, while interrupted live connections keep recovering in the background.

| Stage                                                     | Public error code                     |
| --------------------------------------------------------- | ------------------------------------- |
| Rejected or invalid access grant                          | `access.invalid`                      |
| Access provider unavailable                               | `access.unavailable`                  |
| Sync could not start                                      | `connection.sync_start_failed`        |
| Sync hello/recovery handshake missed the startup deadline | `connection.sync_hello_timeout`       |
| SFU/ICE media startup                                     | `connection.media_start_failed`       |
| Sync recovery budget exhausted                            | `connection.sync_recovery_exhausted`  |
| Media recovery budget exhausted                           | `connection.media_recovery_exhausted` |
| Unsupported capture environment                           | `environment.unsupported`             |
| Unexpected, unclassified exception                        | `client.internal_error`               |

Show the same guidance for `connection.sync_hello_timeout` as for `connection.sync_start_failed`. Media changes that race Sync joining or reconnecting reject with `connection.invalid_state` (`recoverable: true`); wait for the call to connect, then retry.

### Join capture errors

`join()` requests the microphone and camera by default. If a requested device fails, Chalk tries the devices separately and enters with the working ones; the unavailable device is off. A capture warning does not reject `join()`. It arrives as one recoverable `client.on("error")` event (React: `onError`), also available as `connection.lastError`, and its message names the failing device.

| Capture problem                     | Public error code                 |
| ----------------------------------- | --------------------------------- |
| Missing microphone, camera, or both | `media.device_not_found`          |
| Busy microphone or camera           | `media.device_busy`               |
| Denied microphone, camera, or both  | `media.permission_denied`         |
| Unavailable device constraint       | `media.device_constraint_invalid` |
| Other device capture failure        | `media.capture_failed`            |

When both devices fail for different reasons, the warning uses the microphone's code. Do not treat a recoverable capture warning as failed entry. Participants can enable a device later through `client.media`.

Only an unavailable capture API or an insecure browser context fails as nonrecoverable `environment.unsupported`. Joining with both devices explicitly off does not require capture.

## Effect entry

The default entry is Promise-based. Effect applications can use `@q9labsai/chalk-client/effect` for the same `SpaceClient` shape as an Effect program.

## Screen share

```ts
await client.media.setScreenShareEnabled(true, { surface: "window" });
const { capture } = client.getSnapshot().media.screenShare;
await client.media.setScreenShareEnabled(false);
```

`surface` (`"monitor"`, `"window"`, `"browser"`) is a browser hint; the picker decides and `capture.surface` and `capture.label` report the actual choice (`null` when unknown).

`{ surface: "browser", audio: true }` requests tab audio. The picker stays authoritative, so declining audio still shares video. Audio is published separately as `screen_audio` and starts, stops and is revoked with the share. `media.screenShare.hasAudio` reports local live audio, and `participants.roster[].media.screenShareHasAudio` the remote publication. The sharer keeps local playback. Display audio disables echo cancellation, noise suppression and gain control to preserve music, and system audio is excluded. Shared tab audio is not recorded.

## Message reactions

```ts
await client.chat.react({ messageId, emoji: "👏", on: true });
await client.chat.react({ messageId, emoji: "👏", on: false });
```

The action sets a desired state and never toggles, so a retry leaves one membership or none. Anyone with `sendChat` may react. `CHALK_REACTIONS` exports the fixed 24-emoji set shared with call reactions, and other emoji are rejected. A message holds at most 128 memberships; past that, adding returns `overloaded` while removal still works. Each message's `reactions` lists `{ emoji, count, participantIds }`. Message reactions are not rendered in recording timelines.

`SpaceClient` negotiates `collaboration_v2` for this. Deploy the migration and recording validators, then Sync, before the SDK; older SDKs keep working against the updated server. Low-level `createV1SyncClient` consumers opt in with `collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } }`.

## Timeouts

Media-command confirmation deadlines and exhausted retries use `media.timeout` (`recoverable: true`). Reaction acknowledgement deadlines use `collaboration.unavailable` (recoverable); a missing acknowledgement does not show whether anyone received the reaction.

## Whiteboard connection watchdog

The whiteboard-v1 client pings every 4 seconds and replaces the socket through normal reconnect and catch-up after two slow probes. Hidden pages, timer drift above 250 ms and recent whiteboard frames suppress slow samples. Set `watchdog: false` in `ChalkWhiteboardV1ClientOptions` to disable replacement and keep keepalives. `onWatchdogReplacement` receives one bounded event per replacement (reason, measured round trips, outstanding probe ages, next back-off); exceptions in it do not block recovery.
