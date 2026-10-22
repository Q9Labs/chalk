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

### Connection failures

`join()` rejections, `connection.lastError`, and `client.on("error")` use the
same public codes and preserve `recoverable`. Recoverable does not mean joined:
a failed startup needs another `join()`, while interrupted live connections keep
recovering in the background. Device warnings below do not fail entry.

| Stage                                                                        | Public error code                     |
| ---------------------------------------------------------------------------- | ------------------------------------- |
| Rejected or invalid access grant                                             | `access.invalid`                      |
| Access provider unavailable                                                  | `access.unavailable`                  |
| Sync could not start                                                         | `connection.sync_start_failed`        |
| Sync did not finish its hello/recovery handshake before the startup deadline | `connection.sync_hello_timeout`       |
| SFU/ICE media startup                                                        | `connection.media_start_failed`       |
| Sync recovery budget exhausted                                               | `connection.sync_recovery_exhausted`  |
| Media recovery budget exhausted                                              | `connection.media_recovery_exhausted` |
| Unsupported capture environment                                              | `environment.unsupported`             |
| Unexpected, unclassified exception                                           | `client.internal_error`               |

`connection.sync_hello_timeout` is an additive public code. Integrations that
show guidance for `connection.sync_start_failed` should use the same fallback
for this new timeout code. Keep a default branch for future codes. No existing
code is renamed or removed; snapshots and error events now retain the
stage instead of incorrectly reporting `client.internal_error`. Rejected access
and unsupported-environment rejections also retain their nonrecoverable flag.
The React failed screen shows safe stage guidance and a public code reference;
it does not display provider responses or tokens.

Media changes that race Sync joining or reconnecting reject with the existing
`connection.invalid_state` code, `recoverable: true`, and plain connection
guidance. Wait for the call to connect before retrying the media change.

### Join capture errors

`join()` requests the microphone and camera by default. If both work, capture
still uses one request. If a requested device fails, Chalk tries the requested
devices separately and enters with the working devices; the unavailable device
is off. This also applies to the React entrance, including a device that works
in preview but fails at entry. A capture warning does not reject `join()`.

Listen to `client.on("error", ({ error }) => ...)` (React: `onError`) for one
recoverable warning, also available as `connection.lastError`. Its message names
the failing device or devices. React displays a dismissible warning after entry.

| Capture problem                     | Public error code                 |
| ----------------------------------- | --------------------------------- |
| Missing microphone, camera, or both | `media.device_not_found`          |
| Busy microphone or camera           | `media.device_busy`               |
| Denied microphone, camera, or both  | `media.permission_denied`         |
| Unavailable device constraint       | `media.device_constraint_invalid` |
| Other device capture failure        | `media.capture_failed`            |

When both devices fail for different reasons, the warning uses the microphone's
code and names both devices. Integrations must allow these codes and must not
treat a recoverable capture warning as failed entry. Participants can enable a
device later through `client.media` after resolving the problem.

Only an unavailable capture API or an insecure browser context fails capture
as nonrecoverable `environment.unsupported`. Joining with both devices explicitly
off does not require capture. Access, Sync, or media transport failures can still
reject `join()` independently of capture.

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

### Whiteboard connection watchdog

The whiteboard-v1 client pings every 4 seconds (at most 225 payload bytes/minute
when quiet). A probe overdue by 2 seconds triggers an immediate confirmation;
two slow probes replace the socket through normal reconnect and snapshot catch-up.
The first stalled path is detached within 8 seconds of its last healthy probe
cycle, plus reconnect/catch-up. Repeated failures delay the next probe cycle by
1, 2, then at most 4 seconds, so detection on a new connection stays within
12 seconds of welcome, plus catch-up. A minute of timely replies resets back-off.
These bounds require a visible page and timely JavaScript scheduling. Default
watchdog timing uses a monotonic clock; an injected clock must also be monotonic. Timer drift
above 250 ms, hidden/resumed pages (4-second grace), and whiteboard frames received
within the last 2 seconds suppress slow samples: replay volume is progress, not
a stuck path. Catch-up time depends on network and board volume and is not bounded.

Sync sends one ordered anonymous pong per ping. A missing pong can cause an extra
replacement; this costs reconnect/catch-up and is intentional. Unsolicited pongs
are ignored and reset probe evidence. Set `watchdog: false` in
`ChalkWhiteboardV1ClientOptions` to disable slow-path replacement while retaining
4-second keepalives. `onWatchdogReplacement` receives one bounded event per
replacement: reason, up to two measured round trips, up to two outstanding probe
ages (not RTT estimates), and the next back-off. Consumer telemetry exceptions do
not prevent recovery. Subscription stop detaches without waiting for socket close.

### Board view ordering

A participant's last real camera move or Follow-me start wins across tabs. The
first Sync node receiving that intent stamps it with server Unix microseconds
and authenticates the stamp for the origin connection. Within a tab, the SDK's
sequence continues across socket reconnects. Relays preserve the authenticated
origin stamp and geometry. Equal timestamps use the connection UUID as a stable
tie-break. Sync nodes must have synchronized system clocks.

Idle views (including two-second keep-alives), discovery and resize retain the
tab's last stamp. They never take leadership from another tab. A returning tab
leads immediately when the person moves or starts Follow-me, even after minutes
of background throttling. Database restore does not change this order. There is
no database incarnation, quiet timeout or permanently retired connection tuple.
Unchanged views refresh ordering and relay metadata without camera writes or
React commits. Legacy-only views retain per-epoch sequence deduplication.

Production Sync requires `CHALK_SYNC_VIEW_ORIGIN_SECRET`: 32 random bytes encoded
as unpadded base64url, shared by every node in the environment and retained across
database restore. It derives domain-separated per-Episode proof keys without a
database lookup. Configure it before deploying this release. Development and
explicit localhost proof/parity modes use a local fixture key only. Never rotate
it during a rolling deploy: existing view proofs would become invalid.

Authoritative participant removal clears ordering and cached views. Temporary
socket loss keeps both, so automatic recovery does not revive stale views.

The transport delivers all live view observations, including enriched duplicates
and retired views, so consumers can invalidate cached views before filtering.
Use `ChalkWhiteboardViewVersions` to observe ordering before applying or caching a
view; React Board does this automatically. Subscription replay omits retired views.

### Screen capture source hints

```ts
await client.media.setScreenShareEnabled(true, { surface: "window" });
const { capture } = client.getSnapshot().media.screenShare;
// capture?.surface is the actual picker selection; capture?.label is its label.
await client.media.setScreenShareEnabled(false);
```

`surface` accepts `"monitor"`, `"window"`, or `"browser"`. These are browser hints, not filters or guarantees. The browser's picker always decides; unsupported hints do not prevent capture. The call's own tab is excluded where supported, and source switching is enabled. `audio` defaults to `false`; `true` requests capture audio from the browser. The current single-track screen publication remains video-only (captured audio is not published). Missing source settings or labels are reported as `null`.

### Message reactions

```ts
await client.chat.react({ messageId, emoji: "👏", on: true });
await client.chat.react({ messageId, emoji: "👏", on: false });
```

The action sets a desired state, never toggles it. Retrying the same request leaves one membership (or none). Anyone with `sendChat` may react. `CHALK_REACTIONS` exports the fixed 24-emoji set shared with call reactions. Unsupported emoji are rejected. A message has at most 128 reaction memberships across all emoji; adding another returns `overloaded`, while removal remains available.

Each message's `reactions` contains `{ emoji, count, participantIds }`; IDs identify who reacted and can be resolved through the participant roster. Old messages/servers may omit the wire fields; the client normalizes them to an empty list and revision `"0"`. New history includes current reactions. Loaded messages update live, and reconnecting reloads their reaction snapshots. Revisions keep delayed broadcasts/history responses from rolling state backward. Actions taken while reconnecting use the same persisted, participant-scoped offline queue as chat messages. They are cleared if the participant or Episode changes and fail if the message has expired. Deleting a message cascades to its reactions under existing retention.

Message reactions are stored separately from recording facts and are not rendered or added to recording timelines yet. Recording validators accept all 24 call-reaction emoji.

#### Wire compatibility and rollout

SpaceClient negotiates `collaboration_v2` for the 24-emoji set and per-message reactions. Deploy the migration and recording validators, then Sync, before deploying this SDK. Sync continues to serve `collaboration_v1` with the original message shape and six call emoji; it never broadcasts the new per-message frames or expanded call emoji to those sockets. Older SDKs therefore keep working against the updated server. The base sync protocol remains v1. Low-level `createV1SyncClient` consumers opt in with `collaboration: { name: "collaboration_v2", chatCursor: { afterSequence: null, retainedFloorSequence: null } }`; the default low-level extension stays v1. `reactToChatMessage(input)` rejects locally unless v2 was negotiated. New SpaceClient versions require the updated Sync server; there is no downgrade of the message-reaction feature.

### Shared tab audio

`await client.media.setScreenShareEnabled(true, { surface: "browser", audio: true })` requests tab audio. The browser picker remains authoritative: selecting a window or declining audio still shares video normally. Audio is published separately as `screen_audio`; it starts, stops, and is revoked with the share, never with the microphone. `media.screenShare.hasAudio` reports local live audio; `participants.roster[].media.screenShareHasAudio` reports the remote publication. `media.remote` contains the received track.

The sharer keeps local playback (`suppressLocalAudioPlayback: false`). Display audio disables echo cancellation, noise suppression and automatic gain control to preserve music; microphone capture and its processing are unchanged. System audio is excluded to avoid sending the call back to itself. Headphones avoid acoustic doubling through the microphone; local playback cannot be preserved while guaranteeing that loudspeakers never leak into it. Chrome documents [local playback control](https://developer.chrome.com/blog/screen-sharing-improvements-in-chrome-109) and [system-audio feedback](https://developer.chrome.com/docs/web-platform/screen-sharing-controls). [Meet documents the same “Also share tab audio” picker control](https://support.google.com/meet/answer/9308856?hl=en). No public X documentation establishing its echo default was found.

Shared tab audio is excluded from recordings until the recording format supports it. React Native display capture behavior is unchanged.

Media-command confirmation deadlines and exhausted retries use existing
`media.timeout` with `recoverable: true`. This classification applies only to
media commands, not other operations with exhausted retries. Reaction
acknowledgement deadlines use existing `collaboration.unavailable`, recoverable,
with “Couldn’t confirm your reaction. Try again.” A missing acknowledgement does
not establish whether anyone received the reaction.
