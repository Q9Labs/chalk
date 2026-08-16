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
client, renders the Entrance by default, and releases its owned client when it
unmounts.

```tsx
import { Chalk } from "@q9labsai/chalk-react";

export function SpacePage() {
  return (
    <Chalk
      space="design-review"
      getAccess={({ space, reason }) => fetch(`/api/chalk/spaces/${space}/access?reason=${reason}`)}
      defaults={{ microphone: true, camera: true }}
      features={{ chat: true, screenShare: true, reactions: true }}
      spaceName="Design review"
      onEpisodeEnded={({ episode }) => console.log(episode?.id)}
    />
  );
}
```

Pass an existing client when its lifecycle belongs to the embedding
application. Chalk will use it without disposing it.

```tsx
<Chalk client={spaceClient} entrance={false} />
```

`theme` is the only styling door. It accepts a closed token-key set, which
Chalk emits as CSS custom properties scoped to its root. Size and place Chalk
with its parent element.

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

Cosmic Chalk is a ready-made dark theme with a midnight board, moon-white text,
comet-blue focus states, and a slate grain. The same preset works on the full
Space and the standalone Entrance.

```tsx
import { Chalk, COSMIC_CHALK_THEME, Entrance } from "@q9labsai/chalk-react";

<Chalk client={spaceClient} theme={COSMIC_CHALK_THEME} />;

<Entrance spaceName="Design review" theme={COSMIC_CHALK_THEME} onJoin={(settings) => spaceClient.join(settings)} />;
```

## Custom UI

`ChalkProvider` only shares a `SpaceClient` with React. It does not join,
leave, refresh access, or own the client’s lifetime.

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkProvider, useCan, useParticipants, useSpaceClient } from "@q9labsai/chalk-react";

function ParticipantPanel() {
  const client = useSpaceClient();
  const { roster } = useParticipants();
  const canRaiseHand = useCan("raiseHand");

  return (
    <>
      <p>{roster.length} participants</p>
      {canRaiseHand ? <button onClick={() => void client.participants.raiseHand()}>Raise hand</button> : null}
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
`useParticipants`, `useMedia`, `useChat`, `useReactions`, `useWhiteboard`, and
`useCan`. Each snapshot hook returns its stable `SpaceSnapshot` slice; use the
client hook for commands.

`AccessGrant` remains opaque. The application backend creates it, `getAccess`
returns it unchanged, and `SpaceClient` handles refresh and recovery.
