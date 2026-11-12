# @q9labsai/chalk-react-native

React Native bindings, native platform adapters and the drop-in call view for Chalk.

## Install

Install the SDK with every native module it needs as a peer, at the versions your Expo SDK pins:

```sh
npx expo install @q9labsai/chalk-client @q9labsai/chalk-react-native @cloudflare/react-native-webrtc react-native-webview react-native-reanimated react-native-worklets react-native-gesture-handler react-native-safe-area-context react-native-svg expo-audio expo-clipboard expo-crypto expo-document-picker expo-file-system expo-haptics expo-sharing
```

The app must also embed the Figtree font (Regular, Medium, SemiBold and Bold) with the `expo-font` config plugin.

Use `ChalkProvider` instead of `Chalk` to build your own call UI. It receives a `SpaceClient`. Components inside the provider can read snapshots with the hooks and access client actions through `useSpaceClient`. The application owns joining, leaving, disposing the client, and rendering its UI.

## Call view

`Chalk` draws the whole call: header, stage, dock, sheets, menus and toasts. It fills the screen it's given, joins muted with the camera off, and keeps every control inside the safe area in portrait and landscape. It covers the call while it joins or reconnects, and shows a page when the call is over.

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { Chalk, type ColorScheme } from "@q9labsai/chalk-react-native";
import { useState } from "react";

export function DesignReview({ client, onLeave, onRejoin }: { readonly client: SpaceClient; readonly onLeave: () => void; readonly onRejoin: () => void }) {
  const [colorScheme, setColorScheme] = useState<ColorScheme>("dark");
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  return <Chalk callName="Design review" client={client} colorScheme={colorScheme} inviteLink="https://chalk.example/design-review" onColorSchemeChange={setColorScheme} onLeave={onLeave} onRejoin={onRejoin} onSoundsEnabledChange={setSoundsEnabled} soundsEnabled={soundsEnabled} />;
}
```

`Chalk` lays out the call itself, so the stage needs no props. It switches between Spotlight and Grid, moves the active speaker into the spotlight, and sizes screen shares to their shape.

Props worth knowing (see `ChalkProps` for the rest):

- `client` is created by the app with `createNativeSpaceClient` and disposed by the app. `Chalk` joins it.
- `inviteLink` enables copy, share and a QR code in More and the call details. Without it those rows are left out.
- `colorScheme` (dark by default) and `soundsEnabled` (on by default) are controlled: the person changes them in the call details, and `onColorSchemeChange` and `onSoundsEnabledChange` report the choice. Store both and pass them back on the next launch, loaded before the first render.
- `onLeave` fires when the person chooses Home on the page that shows after they leave, the call ends, it fails, or they were removed.
- `onRejoin` fires on Rejoin or Try again. Render `Chalk` again with a new client, since a client that left or ended cannot join a second time.
- `onOpenSettings(permission)` fires just before Open Settings; `resumedAfterSettings` reopens the call afterwards.

`Permission` is `"microphone" | "camera"`.

Leaving shows the "You left" page first, with Rejoin and Home; only Home calls `onLeave`.

### After a permission change

When the microphone or camera isn't allowed, the call shows a notice with Open Settings. iOS restarts the app when a permission changes, so the call is gone when the person comes back. Store the call in `onOpenSettings`, and on the next launch open it again with `resumedAfterSettings`:

```tsx
import type { SpaceClient } from "@q9labsai/chalk-client";
import { Chalk, type Permission } from "@q9labsai/chalk-react-native";

type ResumableCallProps = {
  readonly client: SpaceClient;
  readonly resumed?: Permission;
  readonly saveResume: (permission: Permission) => void;
  readonly onLeave: () => void;
  readonly onRejoin: () => void;
};

export function ResumableCall({ client, resumed, saveResume, onLeave, onRejoin }: ResumableCallProps) {
  return <Chalk callName="Design review" client={client} onLeave={onLeave} onOpenSettings={saveResume} onRejoin={onRejoin} resumedAfterSettings={resumed} />;
}
```

Clear the stored call once you read it, so a later launch doesn't rejoin.

## Before the call lets you in

`ChalkArrival` draws the screens before `Chalk` joins, for a call that asks the host first. Render it in place of `Chalk` while the arrival is pending (`state="knocking"`), after the host denies it (`"refused"`), or when the call is full (`"full"`). Render `Chalk` once the person is let in.

```tsx
import { type ArrivalState, ChalkArrival } from "@q9labsai/chalk-react-native";

export function Arrival({ state, onCancel, onRetry }: { readonly state: ArrivalState; readonly onCancel: () => void; readonly onRetry: () => void }) {
  return <ChalkArrival callName="Design review" onCancel={onCancel} onRetry={onRetry} state={state} />;
}
```

`state` picks the screen: "Asking to join" with Cancel, "The host didn't let you in" with Ask again, or "This call is full" with Try again and Home. `onCancel` stops waiting and `onRetry` knocks again. `recording` shows recording consent while knocking on a recorded call.

## Your own screens

`@q9labsai/chalk-react-native/ui` gives an app's own screens, such as its Home or name step, the same look as the call. Wrap them in `ChalkUI`, which provides the theme, safe areas, sheets, menus and toasts, and build them from the call's primitives.

```tsx
import { ChalkText, ChalkUI, PillButton } from "@q9labsai/chalk-react-native/ui";

export function Home({ onStart }: { readonly onStart: () => void }) {
  return (
    <ChalkUI colorScheme="dark">
      <ChalkText>Start a call or join with a link.</ChalkText>
      <PillButton label="Start a call" onPress={onStart} />
    </ChalkUI>
  );
}
```

## Native client adapter

`@q9labsai/chalk-react-native/client` exports `createNativeSpaceClient`, which connects Chalk to React Native media and application lifecycle APIs.

```tsx
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";

const client = createNativeSpaceClient({ space: "design-review", getAccess });
```

## Development entry

`@q9labsai/chalk-react-native/dev` is for development only. `setMeasurementRegistry` reports each call surface's frame and declared style by testID, and `setDevScenario` opens a sheet or menu and draws fake video in tiles. Require it behind `__DEV__`, so Metro leaves it out of release bundles:

```js
if (__DEV__) {
  const { setDevScenario } = require("@q9labsai/chalk-react-native/dev");
  setDevScenario({ sheet: "more" });
}
```

Don't import it at the top of a file. A static import puts it in every bundle.
