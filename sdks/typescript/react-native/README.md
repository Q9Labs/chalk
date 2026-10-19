# @q9labsai/chalk-react-native

React Native bindings, native platform adapters and the drop-in call view for Chalk.

## Install

Install the SDK with every native module it needs as a peer, at the versions your Expo SDK pins:

```sh
npx expo install @q9labsai/chalk-client @q9labsai/chalk-react-native @cloudflare/react-native-webrtc react-native-webview react-native-reanimated react-native-worklets react-native-gesture-handler react-native-safe-area-context react-native-svg expo-audio expo-haptics expo-clipboard expo-document-picker expo-file-system
```

The app must also embed the Figtree font (Regular, Medium, SemiBold and Bold) with the `expo-font` config plugin.

The root package exports:

- Call view: `Chalk`, `ChalkProps`, `Permission`, `ColorScheme`, and `Palette`.
- Before the call: `ChalkArrival`, `ChalkArrivalProps`, and `ArrivalState`.
- Context: `ChalkProvider`, `useSpaceClient`, and `ChalkProviderProps`.
- Snapshot hooks: `useCan`, `useChat`, `useConnection`, `useMedia`, `useParticipants`, `useReactions`, `useRecording`, `useSelf`, and `useWhiteboard`.
- Invite helpers: `extractSpaceInviteFromLink`, `getClipboardInviteSuggestion`, `parseSpaceInviteLink`, `buildChalkInviteLink`, and `SpaceInviteLink`.

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

`Chalk` lays out the call itself, so the stage needs no props. It switches between Spotlight and Grid, moves the active speaker into the spotlight, and sizes screen shares to their shape. iPad uses the phone layout in 5.0.0.

| Prop                    | Type                                 | What it does                                                                                                                                                                                                          |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`                | `SpaceClient`                        | The call's client. The app creates it with `createNativeSpaceClient` and disposes it. `Chalk` joins it.                                                                                                               |
| `displayName`           | `string`                             | The name others see. Without it, the server's stored name is used.                                                                                                                                                    |
| `callName`              | `string`                             | The call's name in the header, such as "Q9 team". Tapping it opens the call details.                                                                                                                                  |
| `inviteLink`            | `string`                             | The call's link. More offers to copy and share it, and the call details show it with copy, share and a QR code. Without it, they leave those rows out.                                                                |
| `colorScheme`           | `"dark" \| "light"`                  | The call's look. Dark by default.                                                                                                                                                                                     |
| `onColorSchemeChange`   | `(colorScheme: ColorScheme) => void` | Called when the person changes the look in the call details.                                                                                                                                                          |
| `soundsEnabled`         | `boolean`                            | Call sounds. On by default.                                                                                                                                                                                           |
| `onSoundsEnabledChange` | `(enabled: boolean) => void`         | Called when the person turns call sounds on or off.                                                                                                                                                                   |
| `onLeave`               | `() => void`                         | Called when the person is done with the call: from Home on the page that shows after they leave, the call ends, it fails, or they were removed.                                                                       |
| `onRejoin`              | `() => void`                         | Called when the person chooses Rejoin or Try again on a page that shows after they leave, the call ends, or it fails. Give the arrival back and render `Chalk` again with a new client, since the old one can't join. |
| `onOpenSettings`        | `(permission: Permission) => void`   | Called just before Open Settings takes the person to the system settings to allow the microphone or camera.                                                                                                           |
| `resumedAfterSettings`  | `Permission`                         | Set when the app opens the call again after Open Settings. The call says "Rejoining" and then that it can use the device now.                                                                                         |

`Permission` is `"microphone" | "camera"`.

Leaving no longer calls `onLeave` straight away. The "You left" page shows first, with Rejoin and Home, and only Home calls `onLeave`. This is a breaking change from 4.x.

Rejoin and Try again call `onRejoin`, not `onLeave`. Give the arrival back there, then render `Chalk` again with a new client. The client that left or ended can't join the call a second time.

The person can switch the look and call sounds from the call details. The example keeps both in state. To keep the person's choice, store both through the change callbacks and pass them back on the next launch. Load them before you render `Chalk`, so the first frame already has the right theme.

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

| Prop          | Type                                | What it does                                                                                                                                     |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `state`       | `"knocking" \| "refused" \| "full"` | Which screen to show: "Asking to join" with Cancel, "The host didn't let you in" with Ask again, or "This call is full" with Try again and Home. |
| `callName`    | `string`                            | The call's name, such as "Q9 team".                                                                                                              |
| `colorScheme` | `"dark" \| "light"`                 | Dark by default, like `Chalk`.                                                                                                                   |
| `onCancel`    | `() => void`                        | Stops waiting: Cancel while knocking, Home when the call is full, and Android back.                                                              |
| `onRetry`     | `() => void`                        | Knocks again after a refusal, or tries again once a full call has room.                                                                          |
| `recording`   | `boolean`                           | Shows recording consent while knocking on a recorded call.                                                                                       |

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

The entry exports:

- Frame: `ChalkUI` and `ChalkUIProps`.
- Theme: `useTheme`, `Theme`, `fixed`, `fontFamilies`, `radii`, `type`, `ColorScheme`, `Palette`, and `useDeviceLayout`.
- Icons: `Icon` and `IconName`.
- Primitives: `ChalkText`, `IconButton`, `PillButton`, `BottomSheet`, `SheetGroup`, `SheetRow`, `Menu`, `MenuItem`, `Switch`, `SegmentedControl`, `CopyButton`, `FaceAvatar`, `useToasts`, `announce`, `usePressAnimation`, and `Limbo`.

## Native client adapter

`@q9labsai/chalk-react-native/client` exports `createNativeSpaceClient` and `NativeSpaceClientOptions`. The native client connects Chalk to React Native media and application lifecycle APIs.

```tsx
import { createNativeSpaceClient } from "@q9labsai/chalk-react-native/client";

const client = createNativeSpaceClient({ space: "design-review", getAccess });
```

The `runtime`, `clipboard`, `diagnostics`, and `invites` subpaths expose native runtime information, clipboard access, diagnostics state, and invite parsing respectively.

## Development entry

`@q9labsai/chalk-react-native/dev` is for development only. `setMeasurementRegistry` reports each call surface's frame and declared style by testID, and `setDevScenario` opens a sheet or menu and draws fake video in tiles. Require it behind `__DEV__`, so Metro leaves it out of release bundles:

```js
if (__DEV__) {
  const { setDevScenario } = require("@q9labsai/chalk-react-native/dev");
  setDevScenario({ sheet: "more" });
}
```

Don't import it at the top of a file. A static import puts it in every bundle.
