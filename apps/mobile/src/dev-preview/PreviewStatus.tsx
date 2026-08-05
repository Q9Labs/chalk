import { Pressable, StyleSheet, Text, View } from "react-native";

export interface PreviewStatusProps {
  readonly message: string;
  readonly onBack?: () => void;
  readonly onRetry?: () => void;
  readonly title: string;
}

export function PreviewStatus({ message, onBack, onRetry, title }: PreviewStatusProps): React.JSX.Element {
  return (
    <View accessibilityLiveRegion="polite" style={styles.container}>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.message}>{message}</Text>
      <View style={styles.actions}>
        {onBack ? (
          <Pressable accessibilityRole="button" onPress={onBack} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
        ) : null}
        {onRetry ? (
          <Pressable accessibilityRole="button" onPress={onRetry} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Try again</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: "center", flex: 1, justifyContent: "center", padding: 24 },
  title: { color: "#111827", fontSize: 22, fontWeight: "700", textAlign: "center" },
  message: { color: "#4b5563", fontSize: 15, lineHeight: 22, marginTop: 10, maxWidth: 340, textAlign: "center" },
  actions: { flexDirection: "row", gap: 10, marginTop: 24 },
  primaryButton: { backgroundColor: "#111827", borderRadius: 10, paddingHorizontal: 18, paddingVertical: 11 },
  primaryButtonText: { color: "#ffffff", fontWeight: "700" },
  secondaryButton: { borderColor: "#d1d5db", borderRadius: 10, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 11 },
  secondaryButtonText: { color: "#111827", fontWeight: "700" },
});
