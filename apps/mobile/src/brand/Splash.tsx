import { useTheme } from "@q9labsai/chalk-react-native/ui";
import { StyleSheet, View } from "react-native";
import { ChalkMark } from "./ChalkMark";

/** A8: the mark alone on the call background, matching the native launch screen, while the app loads. */
export function Splash({ onLayout }: { readonly onLayout?: () => void }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="Chalk is starting" onLayout={onLayout} style={[styles.root, { backgroundColor: colors.canvas }]} testID="app.splash">
      <ChalkMark color={colors.text} size={112} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center" },
});
