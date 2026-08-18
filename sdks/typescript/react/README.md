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

`theme` is the only styling door. `skin` defaults to `"classic"`; choose
`"chalk"` when you want the hand-drawn Chalk skin. Palette and texture are
independent from the skin, so the same palette and texture can compose with
either choice. Chalk emits the closed token-key set as CSS custom properties
scoped to its root. Size and place Chalk with its parent element.

`colorScheme` accepts `light`, `dark`, or `system`. With `system`, Chalk follows
the browser preference while keeping explicit token overrides in place.

```tsx
<Chalk
  client={spaceClient}
  theme={{
    skin: "chalk",
    palette: "warm-charcoal",
    texture: "paper",
    colorScheme: "dark",
    accent: "#4b9bb8",
    tokens: { canvas: "#152127", surface: "#1d2b31" },
  }}
/>
```

`COSMIC_CHALK_THEME` is a ready-made Chalk-skin theme with a midnight board,
moon-white text, comet-blue focus states, and a slate grain. The preset selects
`skin: "chalk"`; it works on the full Space and the standalone Entrance.

```tsx
import { Chalk, COSMIC_CHALK_THEME, Entrance } from "@q9labsai/chalk-react";

<Chalk client={spaceClient} theme={COSMIC_CHALK_THEME} />;

<Entrance spaceName="Design review" theme={COSMIC_CHALK_THEME} onJoin={(settings) => spaceClient.join(settings)} />;
```

## Hand-drawn UI

The `chalk` skin uses the SDK's chalk-drawn controls throughout. Its rough SVG
edges, powder passes, and focus marks are deterministic, while buttons, inputs,
toggles, dialogs, menus, and sliders remain native accessible controls. The
default `classic` skin keeps the same typed palette and texture choices without
the hand-drawn treatment.

The same pieces are public for custom panels. Each accepts a stable `seed` when
you want a specific stroke to stay identical across renders.
Directly imported `Chalk*` primitives keep their hand-drawn identity; the skin
switch belongs to the turnkey `<Chalk />` and standalone `Entrance` surfaces.

```tsx
import { ChalkButton, ChalkInput, ChalkPanel, ChalkToggle } from "@q9labsai/chalk-react";

<ChalkPanel seed="participant-settings">
  <ChalkInput aria-label="Display name" defaultValue="Hasan" seed="display-name" />
  <ChalkToggle aria-label="Noise suppression" defaultPressed seed="noise-suppression" />
  <ChalkButton tone="accent" variant="solid" seed="save-settings">
    Save settings
  </ChalkButton>
</ChalkPanel>;
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
`useParticipants`, `useMedia`, `useChat`, `useReactions`, `useWhiteboard`, and
`useCan`. Each snapshot hook returns its stable `SpaceSnapshot` slice; use the
client hook for commands.

`AccessGrant` remains opaque. The application backend creates it, `getAccess`
returns it unchanged, and `SpaceClient` handles refresh and recovery.
