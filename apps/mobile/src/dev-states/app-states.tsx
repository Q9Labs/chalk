import { Text } from "react-native";
export const hasAppStates = false;

/** The capture runner installs the shell adapter only in a copy containing the shell views. */
export function AppStates(_props: { screen: string; theme: "dark" | "light"; ready: boolean }) {
  return <Text accessibilityRole="alert">App fixture requires the mobile-redesign-shell views in the captured source.</Text>;
}
