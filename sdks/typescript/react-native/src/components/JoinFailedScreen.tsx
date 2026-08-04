import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Theme } from "../ui/theme";

export interface JoinFailedScreenProps {
  readonly roomName: string;
  readonly message: string;
  readonly onRetry: () => void;
  readonly onHome: () => void;
}

export function JoinFailedScreen({ roomName, message, onRetry, onHome }: JoinFailedScreenProps): React.JSX.Element {
  return (
    <ScrollView contentContainerStyle={styles.errorScreen}>
      <Text style={styles.eyebrow}>Couldn't enter</Text>
      <Text style={styles.title}>{roomName}</Text>
      <Text style={styles.body}>{message}</Text>
      <View style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Try entering the Space again" onPress={onRetry} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Try again</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Return home" onPress={onHome} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Home</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  errorScreen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
    paddingHorizontal: Theme.spacing["2xl"],
    paddingTop: Theme.spacing["6xl"],
    paddingBottom: Theme.spacing["3xl"],
    gap: Theme.spacing.lg,
  },
  eyebrow: { ...Theme.typography.eyebrow, color: Theme.colors.primary },
  title: { ...Theme.typography.title, color: Theme.colors.foreground },
  body: { ...Theme.typography.body, color: Theme.colors.mutedForeground },
  actionRow: { flexDirection: "row", gap: Theme.spacing.md },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.sm,
    backgroundColor: Theme.colors.primary,
    paddingHorizontal: Theme.spacing.xl,
    paddingVertical: Theme.spacing.md,
  },
  primaryButtonText: { color: Theme.colors.primaryForeground, fontSize: 16, fontWeight: "800" },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.sm,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.xl,
    paddingVertical: Theme.spacing.md,
  },
  secondaryButtonText: { color: Theme.colors.foreground, fontSize: 15, fontWeight: "700" },
});
