# @q9labsai/chalk-react

React bindings and UI components for Chalk meeting surfaces.

The provider and hooks project an existing `ChalkSessionStore` from
`@q9labsai/chalk-client` into React. They never join a room or open network
connections on their own; the application creates and owns the session store.

## Installation

```bash
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react @q9labsai/chalk-ui
```

## Setup

```tsx
import "@q9labsai/chalk-ui/styles.css";
```

Wrap the part of the application that consumes session state:

```tsx
import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { ChalkProvider, useChalkActions, useParticipants } from "@q9labsai/chalk-react";

function Meeting() {
  const participants = useParticipants();
  const actions = useChalkActions();

  return (
    <>
      <p>{participants.length} participants</p>
      <button onClick={() => void actions.leave()}>Leave</button>
    </>
  );
}

export function App({ session }: { session: ChalkSessionStore }) {
  return (
    <ChalkProvider session={session}>
      <Meeting />
    </ChalkProvider>
  );
}
```

`useChalkSnapshot` returns the complete immutable snapshot.
`useChalkSelector` limits rerenders to the selected value, while
`useParticipants`, `useLocalMedia`, and `useRemoteMedia` expose the common
collections. `useChalkActions` delegates commands to the provided store and
returns each command's original promise.

## Import Surface

Use the narrowest import that matches the UI layer you need:

```tsx
import { Avatar, VideoTile } from "@q9labsai/chalk-react/atomic";
import { ChatPanel, ControlBar } from "@q9labsai/chalk-react/composite";
import { EndScreen, LoadingScreen } from "@q9labsai/chalk-react/full";
```

The root import is kept for convenience, but bundle-sensitive apps should prefer
the layer subpaths.

## Ownership Boundary

The hooks own React subscriptions only. Joining, transport, permissions,
diagnostics, and recovery stay in `@q9labsai/chalk-client`. Recording and
transcription are not part of this launch surface. The styled `WhiteboardPanel`
is backed by `@q9labsai/chalk-whiteboard`; callers still own its room state and
transport wiring.
