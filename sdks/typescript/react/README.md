# @q9labsai/chalk-react

`@q9labsai/chalk-react` provides the React surface for a Chalk Space. Use
`<Chalk />` for the complete embedded experience, or share a `SpaceClient`
with `<ChalkProvider>` and the snapshot hooks when building custom UI.

## Installation

```bash
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react
```

## Turnkey UI

Provide a Space slug and a `getAccess` callback. Chalk creates and owns the
client, joins directly through CallLimbo, and releases its owned client when it
unmounts.

```tsx
import { Chalk } from "@q9labsai/chalk-react";

export function SpacePage() {
  return (
    <Chalk
      space="design-review"
      getAccess={(request) =>
        fetch("/api/chalk/access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      }
      defaults={{ microphone: true, camera: true }}
      features={{ chat: true, screenShare: true, reactions: true }}
      spaceName="Design review"
      onEpisodeEnded={({ episode }) => console.log(episode?.id)}
    />
  );
}
```

Forward the `getAccess` request unchanged to your authenticated backend. Pass it
as the final `participants.issueAccess` argument with the server-only state from
`getAccessRefreshState`; Chalk selects replacement only when recovery needs it.
See the [web quickstart](../../../docs/sdk-web-quickstart.md) for the endpoint call.

Pass an existing client when its lifecycle belongs to the embedding
application. Chalk will use it without disposing it.

```tsx
<Chalk client={spaceClient} />
```

`theme` controls color scheme, accent and typed token overrides.

`colorScheme` accepts `light`, `dark`, or `system`. With `system`, Chalk follows
the browser preference while keeping explicit token overrides in place.

```tsx
<Chalk
  client={spaceClient}
  theme={{
    colorScheme: "dark",
    accent: "#4b9bb8",
    tokens: { canvas: "#152127", surface: "#1d2b31" },
  }}
/>
```

## Custom UI

`ChalkProvider` only shares a `SpaceClient` with React. It does not join,
leave, refresh access, or own the client’s lifetime.

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkButton, ChalkProvider, useCan, useParticipants, useSpaceClient } from "@q9labsai/chalk-react";

function ParticipantPanel() {
  const client = useSpaceClient();
  const { roster } = useParticipants();
  const canRaiseHand = useCan("raiseHand");

  return (
    <>
      <p>{roster.length} participants</p>
      {canRaiseHand ? <ChalkButton onClick={() => void client.participants.raiseHand()}>Raise hand</ChalkButton> : null}
    </>
  );
}

export function SpacePanel({ client }: { readonly client: SpaceClient }) {
  return (
    <ChalkProvider client={client}>
      <ParticipantPanel />
    </ChalkProvider>
  );
}
```

The public hook set is closed: `useSpaceClient`, `useConnection`, `useSelf`,
`useParticipants`, `useMedia`, `useChat`, `useOffline`, `useReactions`, `useWhiteboard`, and
`useCan`. Each snapshot hook returns its stable `SpaceSnapshot` slice; use the
client hook for commands.

`AccessGrant` remains opaque. The application backend creates it, `getAccess`
returns it unchanged, and `SpaceClient` handles refresh and recovery.

## Component maintenance

`control-bar-behavior.ts` owns the shared contracts, state, and commands for the
controls. The component files own presentation.

The SDK-owned `@q9labsai/chalk-react/preview` dev-tool entrypoint exposes the
preview contract used by the first-party gallery. Application previews should
consume that entrypoint instead of reaching into this package's `src` tree.

### Screen sharing

`useScreenShare()` returns the local screen state, optional `capture: { surface, label }`, and `setEnabled(enabled, options?)`. For example, `await share.setEnabled(true, { surface: "browser", audio: true })` opens the browser picker with a tab hint. `surface` is only a hint; read `capture.surface` for what was actually chosen. `audio` publishes a separate `screen_audio` track when the browser returns one. `hasAudio` reports local share audio; `useParticipants()` exposes `media.screenShareHasAudio` for remote shares. `AudioOutput` plays it through the selected call speaker, using the existing participant/global volume controls. Recordings exclude shared tab audio. `useMedia().screenShare` exposes the same capture metadata.

### Message reactions

```ts
await client.chat.react({ messageId, emoji: "👏", on: true });
await client.chat.react({ messageId, emoji: "👏", on: false });
```

The action sets a desired state, never toggles it. Retrying the same request leaves one membership (or none). Anyone with `sendChat` may react. `CHALK_REACTIONS` exports the fixed 24-emoji set shared with call reactions. Unsupported emoji are rejected. A message has at most 128 reaction memberships across all emoji; adding another returns `overloaded`, while removal remains available.

Each message's `reactions` contains `{ emoji, count, participantIds }`; IDs identify who reacted and can be resolved through the participant roster. Old messages/servers may omit the wire fields; the client normalizes them to an empty list and revision `"0"`. New history includes current reactions. Loaded messages update live, and reconnecting reloads their reaction snapshots. Revisions keep delayed broadcasts/history responses from rolling state backward. Actions taken while reconnecting use the same persisted, participant-scoped offline queue as chat messages. They are cleared if the participant or Episode changes and fail if the message has expired. Deleting a message cascades to its reactions under existing retention.

Message reactions are stored separately from recording facts and are not rendered or added to recording timelines yet. Recording validators accept all 24 call-reaction emoji.

`useChat()` returns the same state and `react(input)` action. Each hook message always has a reactions array; each group adds `isMine` for the current participant. Public types are `MessageReaction`, `ReactChatMessage`, and `UseChatResult`. No reaction UI is added by this change.
