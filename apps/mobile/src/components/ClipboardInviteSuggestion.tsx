import { Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../lib/theme";

export function ClipboardInviteSuggestion({ isLoading, onPress }: { isLoading: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} disabled={isLoading} style={({ pressed }) => [styles.card, pressed && !isLoading && styles.cardPressed, isLoading && styles.cardDisabled]}>
      <View style={styles.copy}>
        <Text style={styles.eyebrow}>Copied invite ready</Text>
        <Text style={styles.title}>Join copied invite</Text>
        <Text style={styles.subtitle}>We found a Chalk invite link in your clipboard.</Text>
      </View>
      <Text style={styles.action}>{isLoading ? "..." : "Open"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.28)",
    backgroundColor: "rgba(27, 182, 166, 0.08)",
  },
  cardPressed: {
    transform: [{ scale: 0.99 }],
    opacity: 0.92,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  copy: {
    flex: 1,
    gap: 4,
  },
  eyebrow: {
    color: Theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.2,
    textTransform: "uppercase",
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "700",
  },
  subtitle: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    lineHeight: 18,
  },
  action: {
    color: Theme.colors.primary,
    fontSize: 14,
    fontWeight: "700",
  },
});
