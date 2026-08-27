# @q9labsai/chalk-react-native

React Native bindings and native platform adapters for Chalk.

The root package exports exactly:

- Components: `Chalk`, `Entrance`.
- Context: `ChalkProvider`, `useSpaceClient`.
- Snapshot hooks: `useCan`, `useChat`, `useConnection`, `useMedia`,
  `useParticipants`, `useReactions`, `useSelf`, and `useWhiteboard`.
- Types: `ChalkFeatures`, `ChalkProps`, `ChalkTheme`, `ChalkThemeTokens`,
  `SpaceLayout`, `EntranceProps`, `EntranceSettings`, and `ChalkProviderProps`.

```tsx
import { Chalk } from "@q9labsai/chalk-react-native";

export function SpaceScreen() {
  return <Chalk displayName="Taylor" getAccess={getAccess} logoUrl="https://example.com/logo.png" space="design-review" theme={{ colorScheme: "dark", accent: "#14b8a6" }} />;
}
```

`Chalk` can instead receive an existing `SpaceClient` through `client`. Set
`entrance={false}` to join immediately; an absent display name is omitted from
the join request. The native experience has focus, grid, and presentation
layouts, and `features.settings` is enabled unless explicitly set to `false`.

## Feedback

The Space action menu includes Feedback. It captures only the Chalk-owned native
view, shows a removable or refreshable preview, and sends bounded Journey,
trace, runtime, and diagnostic context directly to Chalk. Capture failures and
unsupported macOS native capture never block the message.

The host app must install the `react-native-view-shot` peer dependency.
Embedded products use the default `embedded` source; Chalk's mobile app
configures `chalk_mobile`.

The platform subpaths (`android`, `ios`, `ios-phone`, `ios-pad`, and `macos`)
export the same public surface as the root package.

## Native client adapter

For advanced lifecycle ownership, import the React Native implementation seam
from `@q9labsai/chalk-react-native/client`. It exposes only
`createNativeSpaceClient` and `NativeSpaceClientOptions`; it does not add a
second root binding shape.

```tsx
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";

const client = createNativeSpaceClient({ space: "design-review", getAccess });
```
