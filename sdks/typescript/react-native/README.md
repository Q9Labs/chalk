# @q9labsai/chalk-react-native

React Native bindings, native platform adapters and the drop-in call view for Chalk.

The root package exports:

- Call view: `Chalk`, `ChalkProps`, `ColorScheme`, and `Palette`.
- Context: `ChalkProvider`, `useSpaceClient`, and `ChalkProviderProps`.
- Snapshot hooks: `useCan`, `useChat`, `useConnection`, `useMedia`, `useParticipants`, `useReactions`, `useRecording`, `useSelf`, and `useWhiteboard`.
- Invite helpers: `extractSpaceInviteFromLink`, `getClipboardInviteSuggestion`, `parseSpaceInviteLink`, `buildChalkInviteLink`, and `SpaceInviteLink`.

Use `ChalkProvider` instead of `Chalk` to build your own call UI. It receives a `SpaceClient`. Components inside the provider can read snapshots with the hooks and access client actions through `useSpaceClient`. The application owns joining, leaving, disposing the client, and rendering its UI.

## Call view

`Chalk` draws the whole call: header, stage, dock, sheets, menus and toasts. It fills the screen it's given, joins muted with the camera off, and keeps every control inside the safe area in portrait, landscape and on iPad.

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { Chalk, type ColorScheme } from "@q9labsai/chalk-react-native";
import { useState } from "react";

export function DesignReview({ client, onLeave }: { readonly client: SpaceClient; readonly onLeave: () => void }) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>("dark");
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  return <Chalk callName="Design review" client={client} colorScheme={colorScheme} onColorSchemeChange={setColorScheme} onLeave={onLeave} onSoundsEnabledChange={setSoundsEnabled} soundsEnabled={soundsEnabled} />;
}
```

The call is dark unless `colorScheme` says `"light"`. The person can switch it, and call sounds, from the call's More sheet. The example keeps both in state; store them through the change callbacks and pass them back on the next launch. Load them before you render `Chalk`, so the first frame already has the right theme.

The app must install the native modules `Chalk` uses, at the versions Expo SDK 55 pins: `react-native-reanimated`, `react-native-worklets`, `react-native-gesture-handler`, `react-native-safe-area-context`, `react-native-svg`, `expo-audio` and `expo-haptics`. It must also embed the Figtree font (Regular, Medium, SemiBold and Bold) with the `expo-font` config plugin.

## Native client adapter

`@q9labsai/chalk-react-native/client` exports `createNativeSpaceClient` and `NativeSpaceClientOptions`. The native client connects Chalk to React Native media and application lifecycle APIs.

```tsx
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";

const client = createNativeSpaceClient({ space: "design-review", getAccess });
```

The `runtime`, `clipboard`, `diagnostics`, and `invites` subpaths expose native runtime information, clipboard access, diagnostics state, and invite parsing respectively.
