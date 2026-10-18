import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DeviceLayoutProvider } from "../frame/device-layout";
import { PortalHost, PortalProvider } from "../frame/portal";
import { ToastProvider, ToastStack } from "../primitives/toast/ToastStack";
import { ThemeProvider } from "../theme/theme";
import type { ColorScheme } from "../theme/tokens";

export type ChalkUIProps = {
  readonly colorScheme: ColorScheme;
  readonly children: ReactNode;
};

/**
 * Everything the call's primitives need, for the screens an app draws around `Chalk` (its Home, for
 * example): theme, safe areas, sheets, menus and toasts. Sheets and menus open above `children`.
 */
export function ChalkUI({ colorScheme, children }: ChalkUIProps): React.JSX.Element {
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <ThemeProvider colorScheme={colorScheme}>
          <DeviceLayoutProvider>
            <PortalProvider>
              <ToastProvider>
                <View style={styles.root}>
                  {children}
                  <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                    <PortalHost layer="sheets" />
                  </View>
                  <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
                    <PortalHost layer="menus" />
                  </View>
                  <ToastStack />
                </View>
              </ToastProvider>
            </PortalProvider>
          </DeviceLayoutProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
