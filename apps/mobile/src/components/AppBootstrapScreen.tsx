import { ChalkLogoElements } from "@q9labs/chalk-react-native";
import { Theme } from "@q9labs/chalk-react-native/theme";
import { StyleSheet, Text, View } from "react-native";

export function AppBootstrapScreen({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.container}>
      <View style={styles.illustrationFrame}>
        <View style={styles.glow} />
        <ChalkLogoElements size={84} />
      </View>
      <Text style={styles.brand}>chalk</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.background,
    paddingHorizontal: 32,
    gap: 16,
  },
  illustrationFrame: {
    width: 144,
    height: 144,
    borderRadius: 72,
    backgroundColor: "rgba(27, 182, 166, 0.05)",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  glow: {
    position: "absolute",
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Theme.colors.primary,
    opacity: 0.12,
  },
  brand: {
    fontSize: 28,
    fontWeight: "800",
    color: Theme.colors.foreground,
    letterSpacing: -1,
  },
  label: {
    fontSize: 15,
    lineHeight: 22,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
});
