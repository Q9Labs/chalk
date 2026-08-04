import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import type { useChalkSnapshot } from "../hooks/useChalkSnapshot";
import { Theme } from "../ui/theme";

export type ConnectionStatusSnapshot = Pick<ReturnType<typeof useChalkSnapshot>, "state" | "connection" | "failure">;

export type ConnectionStatusBannerState =
  | {
      readonly kind: "reconnecting";
      readonly message: string;
    }
  | {
      readonly kind: "recoverable-failure";
      readonly message: string;
    };

export interface ConnectionStatusBannerProps {
  readonly status: ConnectionStatusBannerState;
  readonly onRetry?: () => void;
}

export function deriveConnectionStatus(snapshot: ConnectionStatusSnapshot): ConnectionStatusBannerState | null {
  const runtimeActive = snapshot.state === "live" || snapshot.state === "reconnecting";
  if (!runtimeActive) return null;

  const isRecovering = snapshot.state === "reconnecting" || snapshot.connection.sync === "connecting" || snapshot.connection.sync === "recovering" || snapshot.connection.media === "connecting" || snapshot.connection.media === "recovering";
  if (isRecovering) return { kind: "reconnecting", message: "The Space connection was interrupted. Recovering now." };

  const connectionFailed = snapshot.connection.sync === "failed" || snapshot.connection.media === "failed";
  if (connectionFailed && snapshot.failure?.recoverable) return { kind: "recoverable-failure", message: snapshot.failure.message || "The Space connection needs to be retried." };

  return null;
}

export function ConnectionStatusBanner({ status, onRetry }: ConnectionStatusBannerProps): React.JSX.Element {
  const isRecovering = status.kind === "reconnecting";
  const title = isRecovering ? "Reconnecting to the Space" : "Space connection needs attention";

  return (
    <View accessibilityLabel={`${title}. ${status.message}`} accessibilityLiveRegion={isRecovering ? "polite" : "assertive"} accessibilityRole="alert" style={styles.banner}>
      <View style={styles.copy}>
        {isRecovering ? <ActivityIndicator accessibilityLabel="Recovering Space connection" color={Theme.colors.information} size="small" /> : <View accessibilityElementsHidden style={styles.failureMarker} />}
        <View style={styles.text}>
          <Text accessibilityRole="header" style={styles.title}>
            {title}
          </Text>
          <Text style={styles.message}>{status.message}</Text>
        </View>
      </View>
      {!isRecovering && onRetry ? (
        <Pressable accessibilityLabel="Retry the Space connection" accessibilityRole="button" onPress={onRetry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    alignItems: "center",
    backgroundColor: Theme.colors.informationBackground,
    borderBottomColor: Theme.colors.line,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: Theme.spacing.md,
    justifyContent: "space-between",
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
  },
  copy: { alignItems: "center", flex: 1, flexDirection: "row", gap: Theme.spacing.sm, minWidth: 0 },
  text: { flex: 1, minWidth: 0 },
  title: { ...Theme.typography.label, color: Theme.colors.ink },
  message: { ...Theme.typography.meta, color: Theme.colors.information, marginTop: 1 },
  failureMarker: { backgroundColor: Theme.colors.warning, borderRadius: Theme.radius.full, height: 10, width: 10 },
  retryButton: { alignItems: "center", borderColor: Theme.colors.information, borderRadius: Theme.radius.sm, borderWidth: 1, justifyContent: "center", minHeight: 40, paddingHorizontal: Theme.spacing.md },
  retryText: { ...Theme.typography.label, color: Theme.colors.information },
  pressed: { opacity: 0.72 },
});
