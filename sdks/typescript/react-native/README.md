# @q9labsai/chalk-react-native

React Native bindings and native platform adapters for Chalk. The package provides headless call state and actions; it does not provide call screens or themes.

The root package exports:

- Context: `ChalkProvider`, `useSpaceClient`, and `ChalkProviderProps`.
- Snapshot hooks: `useCan`, `useChat`, `useConnection`, `useMedia`, `useParticipants`, `useReactions`, `useRecording`, `useSelf`, and `useWhiteboard`.
- Invite helpers: `extractSpaceInviteFromLink`, `getClipboardInviteSuggestion`, `parseSpaceInviteLink`, `buildChalkInviteLink`, and `SpaceInviteLink`.

`ChalkProvider` receives a `SpaceClient`. Components inside the provider can read snapshots with the hooks and access client actions through `useSpaceClient`. The application owns joining, leaving, disposing the client, and rendering its UI.

## Native client adapter

`@q9labsai/chalk-react-native/client` exports `createNativeSpaceClient` and `NativeSpaceClientOptions`. The native client connects Chalk to React Native media and application lifecycle APIs.

```tsx
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";

const client = createNativeSpaceClient({ space: "design-review", getAccess });
```

The `runtime`, `clipboard`, `diagnostics`, and `invites` subpaths expose native runtime information, clipboard access, diagnostics state, and invite parsing respectively.
