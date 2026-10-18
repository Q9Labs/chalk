import type { SpaceClient } from "@q9labsai/chalk-client";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChalkProvider } from "../context/space-client-context";
import { ToastProvider } from "../primitives/toast/ToastStack";
import { releaseSounds } from "../sounds/sounds";
import { ThemeProvider } from "../theme/theme";
import type { ColorScheme } from "../theme/tokens";
import { StageViewProvider } from "../stage/stage-view";
import { CallFrame } from "./CallFrame";
import { DeviceLayoutProvider } from "./device-layout";
import { PortalProvider } from "./portal";
import { PreferencesProvider } from "./preferences";

export type ChalkProps = {
  /** The call's client. The app creates it with `createNativeSpaceClient` and disposes it; `Chalk` joins it. */
  readonly client: SpaceClient;
  /** The name others see. Without it the server's stored name is used. */
  readonly displayName?: string;
  /** The call's name in the header, such as "Q9 team". */
  readonly callName?: string;
  /** Dark by default. Set it with `onColorSchemeChange` to keep the person's choice. */
  readonly colorScheme?: ColorScheme;
  readonly onColorSchemeChange?: (colorScheme: ColorScheme) => void;
  /** Call sounds, on by default. Set it with `onSoundsEnabledChange` to keep the person's choice. */
  readonly soundsEnabled?: boolean;
  readonly onSoundsEnabledChange?: (enabled: boolean) => void;
  /** Called after the person leaves the call. */
  readonly onLeave?: () => void;
};

/**
 * The drop-in call view. It fills the screen it's given, joins the call muted and with the camera
 * off, and draws everything inside the safe area in portrait, landscape and on iPad.
 */
export function Chalk({ client, colorScheme, onColorSchemeChange, soundsEnabled, onSoundsEnabledChange, ...frame }: ChalkProps): React.JSX.Element {
  useEffect(() => releaseSounds, []);
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <PreferencesProvider colorScheme={colorScheme} onColorSchemeChange={onColorSchemeChange} onSoundsEnabledChange={onSoundsEnabledChange} soundsEnabled={soundsEnabled}>
          {(preferences) => (
            <ThemeProvider colorScheme={preferences.colorScheme}>
              <DeviceLayoutProvider>
                <PortalProvider>
                  <ToastProvider>
                    <ChalkProvider client={client}>
                      <StageViewProvider>
                        <CallFrame {...frame} />
                      </StageViewProvider>
                    </ChalkProvider>
                  </ToastProvider>
                </PortalProvider>
              </DeviceLayoutProvider>
            </ThemeProvider>
          )}
        </PreferencesProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
