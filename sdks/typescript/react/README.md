# @q9labsai/chalk-react

Turnkey React conference experience and composable UI components for Chalk.

`VideoConference` owns the embedded lifecycle from pre-join through the active
conference and end state. Applications provide credentials and a
`createSession` function; the component owns the session store after the user
joins.

## Installation

```bash
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react @q9labsai/chalk-ui
```

## Turnkey conference

```tsx
import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import type { PreJoinSettings } from "@q9labsai/chalk-react";
import { VideoConference } from "@q9labsai/chalk-react";

export function App({ createSession }: { createSession: (settings: PreJoinSettings) => Promise<ChalkSessionStore> }) {
  return <VideoConference roomId="design-review" roomName="Design review" createSession={createSession} chatEnabled participantsEnabled screenShareEnabled />;
}
```

`createSession` is called with the settings selected in `PreJoinScreen`. Set
`autoJoin` when the application has already collected identity and device
settings. Use `phase`/`onPhaseChange` and `layout`/`onLayoutChange` for
controlled observability. Feature availability uses props such as
`chatEnabled`; capability overrides use props such as `canShareScreen`.

## Composable session bindings

The provider and hooks project an existing `ChalkSessionStore` from
`@q9labsai/chalk-client` into React. They never join a room or open network
connections on their own; the application creates and owns the session store.

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
import { Avatar, ParticipantTile, ChatPanel, ControlBar, EndScreen, JoiningScreen, ConferenceView } from "@q9labsai/chalk-react/components";
```

The package root exports `VideoConference`, `ChalkProvider`, and the canonical
session hooks. Active composition components such as `ConferenceView` are
available only from `/components`.

## Ownership Boundary

The hooks own React subscriptions only. Joining, transport, permissions,
diagnostics, and recovery stay in `@q9labsai/chalk-client`. Recording and
transcription are not part of this launch surface. The styled `WhiteboardView`
is backed by `@q9labsai/chalk-whiteboard`; callers still own its room state and
transport wiring.
