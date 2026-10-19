import { StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useBackHandler } from "../frame/back-handler";
import { Limbo } from "../limbo/Limbo";
import { ThemeProvider, useTheme } from "../theme/theme";
import type { ColorScheme } from "../theme/tokens";
import { StatusPage } from "./StatusPage";

/** Where a person stands before the call lets them in: waiting for the host, turned away, or the call is full. */
export type ArrivalState = "knocking" | "refused" | "full";

export type ChalkArrivalProps = {
  readonly state: ArrivalState;
  /** The call's name, such as "Q9 team". */
  readonly callName: string;
  /** Dark by default, like `Chalk`. */
  readonly colorScheme?: ColorScheme;
  /** Stops waiting (Cancel while knocking, Android back). */
  readonly onCancel: () => void;
  /** Knocks again after a refusal, or tries again once a full call has room. */
  readonly onRetry: () => void;
  /** Recording consent shows while knocking on a recorded call. */
  readonly recording?: boolean;
};

/**
 * The screens before `Chalk` joins (T3, T4, A7), for an app that lets a person ask to join a call
 * through an invite link: "Asking to join" with Cancel, "The host didn’t let you in" with Ask again,
 * and "This call is full" with Try again and Home.
 */
export function ChalkArrival({ colorScheme = "dark", ...props }: ChalkArrivalProps): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <ThemeProvider colorScheme={colorScheme}>
        <ArrivalScreen {...props} />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

export function ArrivalScreen({ state, callName, onCancel, onRetry, recording = false }: Omit<ChalkArrivalProps, "colorScheme">): React.JSX.Element {
  const { colors } = useTheme();
  useBackHandler(true, onCancel);
  return (
    <View style={[styles.screen, { backgroundColor: colors.canvas }]} testID="arrival.screen">
      {state === "full" ? <StatusPage callName={callName} onHome={onCancel} onRejoin={onRetry} outcome="full" /> : <Limbo callName={callName} recording={recording} state={state === "knocking" ? { kind: "knocking", onCancel } : { kind: "refused", onAskAgain: onRetry }} />}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
