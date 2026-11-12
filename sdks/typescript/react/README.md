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

Sound cues are on by default. People already in a call hear a quiet chime when
a new participant joins, at most once every three seconds. Initial rosters,
your own joins, and reconnects do not chime. Playback follows browser autoplay
rules: the Join click enables audio, with later clicks or key presses retrying
blocked audio. A refusal never interrupts the call or queues old chimes.
Embedding apps can disable all cues with `features={{ sounds: false }}` on
`Chalk` or `SpaceView`. A participant's Sounds preference also applies.

Pass an existing client when its lifecycle belongs to the embedding
application. Chalk will use it without disposing it.

```tsx
<Chalk client={spaceClient} />
```

`theme` controls color scheme, accent and typed token overrides.

`colorScheme` accepts `light` or `dark` and defaults to dark. Use `onColorSchemeChange` to persist the choice from the call details popover.

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

Each snapshot hook (`useConnection`, `useSelf`, `useParticipants`, `useMedia`, `useChat`, `useOffline`, `useReactions`, `useWhiteboard`, `useCan`) returns its stable `SpaceSnapshot` slice. Use `useSpaceClient` for commands.

## Preview entrypoint

The `@q9labsai/chalk-react/preview` dev-tool entrypoint exposes the preview contract used by the first-party gallery. Application previews should use it instead of reaching into this package's `src` tree.

## Screen sharing

`useScreenShare()` returns the local screen state, `capture: { surface, label }` and `setEnabled(enabled, options?)`. `surface` is only a hint, so read `capture.surface` for the actual choice. `audio: true` publishes a separate `screen_audio` track when the browser returns one. `hasAudio` reports local share audio, and `useParticipants()` exposes `media.screenShareHasAudio` for remote shares. Recordings exclude shared tab audio.

## Message reactions

`useChat()` returns messages with a `reactions` array of `{ emoji, count, participantIds }` (plus `isMine` per group) and `react({ messageId, emoji, on })`. The action sets a desired state and never toggles. The reaction rules (24-emoji `CHALK_REACTIONS`, 128 memberships per message, offline queueing) are in the `@q9labsai/chalk-client` README.
