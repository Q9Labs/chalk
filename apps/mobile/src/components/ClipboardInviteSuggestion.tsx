import { Theme } from "@q9labs/chalk-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

export function ClipboardInviteSuggestion({ isLoading, onPress }: { isLoading: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} disabled={isLoading} style={({ pressed }) => [styles.card, pressed && !isLoading && styles.cardPressed, isLoading && styles.cardDisabled]}>
      <View style={styles.copy}>
        <Text style={styles.title}>Join from clipboard</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          We found an invite link in your clipboard
        </Text>
      </View>
      <View style={styles.actionButton}>
        <Text style={styles.actionText}>{isLoading ? "..." : "Join"}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  cardPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
  cardDisabled: {
    opacity: 0.5,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
  subtitle: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "500",
  },
  actionButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: Theme.colors.primary,
    borderRadius: 10,
  },
  actionText: {
    color: "white",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
  },
});
