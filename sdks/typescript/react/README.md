# @q9labsai/chalk-react

React bindings and composable UI for a Chalk Space.

`@q9labsai/chalk-client` owns the framework-agnostic `SpaceClient`: lifecycle,
access refresh, transport, recovery, controllers, and the stable
`SpaceSnapshot` store. This package binds that store to React and provides the
current turnkey and composable components.

## Installation

```bash
pnpm add @q9labsai/chalk-client @q9labsai/chalk-react @q9labsai/chalk-ui
```

## Create the client

The only client integration seam is `getAccess`. The backend returns an opaque
`AccessGrant`; the browser forwards it unchanged and never constructs,
parses, or reads its fields.

```tsx
import { createSpaceClient, type AccessGrant } from "@q9labsai/chalk-client";

const client = createSpaceClient({
  space: "design-review",
  getAccess: ({ space, reason }): Promise<AccessGrant> => fetchAccess({ space, reason }),
});
```

`SpaceClient` exposes flat `join`/`leave` lifecycle methods and the
`media`, `chat`, `participants`, `reactions`, and `whiteboard` controllers.
React code can subscribe to `client.getSnapshot()` directly, or use the
package bindings below.

## Turnkey Space experience

The current compatibility component owns the pre-live, active, and terminal
states. Applications provide the binding store through a callback; keep the
underlying access callback on `SpaceClient`.

```tsx
import type { VideoConferenceProps as CompatibilityProps } from "@q9labsai/chalk-react";
import { VideoConference as SpaceExperience } from "@q9labsai/chalk-react";

export function App({ createStore }: { createStore: CompatibilityProps["createSession"] }) {
  const props = {
    roomId: "design-review",
    roomName: "Design review",
    createSession: createStore,
    chatEnabled: true,
    participantsEnabled: true,
    screenShareEnabled: true,
  } satisfies CompatibilityProps;
  return <SpaceExperience {...props} />;
}
```

The callback receives the selected `PreJoinSettings` and returns the
SpaceClient-backed binding store. Set `autoJoin` when identity and device
settings are already known. Use `layout`/`onLayoutChange` for controlled layout
state. Feature props such as `chatEnabled` describe available UI; capability
checks on the snapshot decide which commands the current Participant may use.

## Composable client bindings

`ChalkProvider` accepts the public `SpaceClient` and binds its store to React.
It does not open connections or refresh access on its own; `SpaceClient` owns
those operations.

```tsx
import "@q9labsai/chalk-ui/styles.css";
```

Wrap the part of the application that consumes the store:

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { ChalkProvider, useChalkActions, useParticipants } from "@q9labsai/chalk-react";

function SpacePanel() {
  const participants = useParticipants();
  const actions = useChalkActions();

  return (
    <>
      <p>{participants.length} participants</p>
      <button onClick={() => void actions.leave()}>Leave</button>
    </>
  );
}

export function App({ client }: { client: SpaceClient }) {
  return (
    <ChalkProvider session={client}>
      <SpacePanel />
    </ChalkProvider>
  );
}
```

The provider's compatibility prop accepts the public `SpaceClient`.
`useChalkSnapshot` returns the immutable snapshot; `useChalkSelector`
limits rerenders to a selected value; and `useParticipants`, `useLocalMedia`,
and `useRemoteMedia` expose common slices. `useChalkActions` delegates commands
to the store and preserves each command's original promise.

## Import surface

Use the narrowest import that matches the UI layer you need:

```tsx
import { Avatar, ParticipantTile, ChatPanel, ControlBar, EndScreen, JoiningScreen, ConferenceView as SpaceView } from "@q9labsai/chalk-react/components";
```

The package root exports the compatibility turnkey component, `ChalkProvider`,
and the client-backed hooks. Active composition components are available only
from `/components`.

## Ownership boundary

The hooks own React subscriptions only. Joining, transport, permissions,
diagnostics, recovery, and opaque `AccessGrant` refresh stay in
`@q9labsai/chalk-client`. Recording and transcription are not part of this
launch surface. The styled `WhiteboardView` is backed by
`@q9labsai/chalk-whiteboard`; callers still own its Space state and transport
wiring.
