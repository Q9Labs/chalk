import { Theme } from "@q9labsai/chalk-react-native/theme";
import { Pressable, StyleSheet, Text, View, ActivityIndicator } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import Copy01Icon from "@hugeicons/core-free-icons/dist/esm/Copy01Icon";

export function ClipboardInviteSuggestion({ isLoading, onPress }: { isLoading: boolean; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} disabled={isLoading} style={({ pressed }) => [styles.card, pressed && !isLoading && styles.cardPressed, isLoading && styles.cardDisabled]}>
      <View style={styles.iconContainer}>
        <HugeiconsIcon icon={Copy01Icon} size={20} color={Theme.colors.primary} />
      </View>
      <View style={styles.copy}>
        <Text style={styles.title}>Join from clipboard</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          Invite link found in your clipboard
        </Text>
      </View>
      <View style={[styles.actionButton, isLoading && styles.actionButtonLoading]}>{isLoading ? <ActivityIndicator size="small" color="white" /> : <Text style={styles.actionText}>Join</Text>}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.md,
    borderRadius: Theme.radius.xl,
    borderWidth: 1.5,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    gap: Theme.spacing.md,
    ...Theme.shadows.sm,
  },
  cardPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
    borderColor: Theme.colors.primary,
  },
  cardDisabled: {
    opacity: 0.7,
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: Theme.radius.lg,
    backgroundColor: "rgba(27, 182, 166, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    gap: 1,
  },
  title: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
  },
  subtitle: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  actionButton: {
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
    backgroundColor: Theme.colors.primary,
    borderRadius: Theme.radius.lg,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonLoading: {
    backgroundColor: Theme.colors.muted,
  },
  actionText: {
    color: "white",
    fontSize: 14,
    fontWeight: "700",
  },
});
