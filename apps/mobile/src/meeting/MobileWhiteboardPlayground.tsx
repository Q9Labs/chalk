import { ChalkEmbeddedWhiteboard } from "@q9labsai/chalk-react-native";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import { useCallback, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { createMobileWhiteboardPlaygroundTransport } from "./mobile-whiteboard-playground-transport";

const mobileWhiteboardPlaygroundRendererCapabilities = Object.freeze({
  canClear: true,
  canDraw: true,
  theme: "light" as const,
});

export function createMobileWhiteboardPlaygroundJourneyId(now = Date.now()): string {
  return `local-whiteboard-${now}`;
}

export function MobileWhiteboardPlayground({ onClose }: { readonly onClose: () => void }): React.JSX.Element {
  const transport = useMemo(createMobileWhiteboardPlaygroundTransport, []);
  const journeyId = useMemo(createMobileWhiteboardPlaygroundJourneyId, []);
  const [error, setError] = useState<string | null>(null);
  const handleError = useCallback((value: { readonly code: string; readonly message: string }) => setError(`${value.code}: ${value.message}`), []);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.heading}>
          <Text style={styles.title}>Whiteboard renderer playground</Text>
          <Text style={styles.subtitle}>Local only · no meeting collaboration</Text>
        </View>
        <Pressable accessibilityLabel="Close whiteboard renderer playground" accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.closeButton, pressed && styles.pressed]}>
          <Text style={styles.closeButtonText}>Close</Text>
        </Pressable>
      </View>
      {error ? (
        <View style={styles.error}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
      <ChalkEmbeddedWhiteboard {...mobileWhiteboardPlaygroundRendererCapabilities} journeyId={journeyId} onError={handleError} style={styles.whiteboard} testID="mobile-whiteboard-renderer-playground" transport={transport} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Theme.spacing.md,
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
  },
  heading: {
    flex: 1,
    gap: 2,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 17,
    fontWeight: "800",
  },
  subtitle: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
  },
  closeButton: {
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  closeButtonText: {
    color: Theme.colors.foreground,
    fontSize: 14,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.75,
  },
  error: {
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
    backgroundColor: "rgba(239, 68, 68, 0.12)",
  },
  errorText: {
    color: Theme.colors.error,
    fontSize: 12,
    fontWeight: "600",
  },
  whiteboard: {
    flex: 1,
  },
});
