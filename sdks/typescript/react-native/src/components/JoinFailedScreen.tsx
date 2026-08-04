import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Theme } from "../ui/theme";

export interface JoinFailedScreenProps {
  /** Legacy context shown when no explicit title is supplied. */
  readonly roomName?: string;
  readonly title?: string;
  readonly message: string;
  readonly supportCode?: string;
  readonly onRetry: () => void;
  /** Preferred callback for returning to the Entrance. */
  readonly onBack?: () => void;
  /** Legacy alias for `onBack`; kept for existing integrations. */
  readonly onHome?: () => void;
}

const DEFAULT_TITLE = "Couldn’t enter the Space";

export function JoinFailedScreen({ roomName, title, message, supportCode, onRetry, onBack, onHome }: JoinFailedScreenProps): React.JSX.Element {
  const resolvedTitle = title ?? roomName ?? DEFAULT_TITLE;
  const backAction = onBack ?? onHome;
  const backLabel = onBack ? "Back to Entrance" : "Home";

  return (
    <ScrollView contentContainerStyle={styles.errorScreen}>
      <Text style={styles.eyebrow}>Couldn't enter</Text>
      <Text accessibilityRole="header" style={styles.title}>
        {resolvedTitle}
      </Text>
      <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" style={styles.body}>
        {message}
      </Text>
      {supportCode ? (
        <View style={styles.supportCode}>
          <Text style={styles.supportCodeLabel}>Support code</Text>
          <Text accessibilityLabel={`Support code ${supportCode}`} selectable style={styles.supportCodeValue}>
            {supportCode}
          </Text>
        </View>
      ) : null}
      <View accessibilityLabel="Entry actions" accessibilityRole="toolbar" style={styles.actionRow}>
        <Pressable accessibilityRole="button" accessibilityLabel="Try entering the Space again" onPress={onRetry} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Try again</Text>
        </Pressable>
        {backAction ? (
          <Pressable accessibilityRole="button" accessibilityLabel={onBack ? backLabel : "Return home"} onPress={backAction} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>{backLabel}</Text>
          </Pressable>
        ) : null}
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
  supportCode: {
    gap: Theme.spacing.xs,
    borderRadius: Theme.radius.md,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  supportCodeLabel: { ...Theme.typography.eyebrow, color: Theme.colors.mutedForeground },
  supportCodeValue: { color: Theme.colors.foreground, fontFamily: "monospace", fontSize: 14, lineHeight: 20 },
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
