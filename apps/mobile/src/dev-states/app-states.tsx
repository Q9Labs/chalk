import { Text } from "react-native";
import type { ReactNode } from "react";
export const hasAppStates = false;

/** The capture runner installs the shell adapter only in a copy containing the shell views. */
export function AppStates(_props: { screen: string; theme: "dark" | "light"; ready: boolean; call: ReactNode }) {
  return <Text accessibilityRole="alert">App fixture requires the mobile-redesign-shell views in the captured source.</Text>;
}
