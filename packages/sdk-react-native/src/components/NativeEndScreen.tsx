import { Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";

export interface NativeMeetingEndData {
  roomId: string;
  roomName: string;
  durationSeconds: number;
  participantCount: number;
  chatCount: number;
  transcriptCount: number;
}

export interface NativeEndScreenProps {
  data: NativeMeetingEndData;
  onRejoin: () => void;
  onGoHome: () => void;
}

export function NativeEndScreen({ data, onRejoin, onGoHome }: NativeEndScreenProps): React.JSX.Element {
  return (
    <View style={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.eyebrow}>You've left the meeting</Text>
        <Text style={styles.title}>{data.roomName}</Text>
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>Duration</Text>
            <Text style={styles.statValue}>{formatDuration(data.durationSeconds)}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>People</Text>
            <Text style={styles.statValue}>{data.participantCount}</Text>
          </View>
        </View>
        <View style={styles.meta}>
          <Text style={styles.metaText}>Messages: {data.chatCount}</Text>
          <Text style={styles.metaText}>Transcript lines: {data.transcriptCount}</Text>
        </View>
        <Pressable onPress={onRejoin} style={styles.primaryButton}>
          <Text style={styles.primaryButtonText}>Rejoin</Text>
        </Pressable>
        <Pressable onPress={onGoHome} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>Home</Text>
        </Pressable>
      </View>
    </View>
  );
}

function formatDuration(seconds: number) {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: Theme.spacing["2xl"],
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius["2xl"],
    backgroundColor: Theme.colors.card,
    padding: Theme.spacing["2xl"],
    gap: Theme.spacing.lg,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
    textAlign: "center",
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
    textAlign: "center",
  },
  statsRow: {
    flexDirection: "row",
    gap: Theme.spacing.md,
  },
  statCard: {
    flex: 1,
    borderRadius: Theme.radius.xl,
    backgroundColor: Theme.colors.secondary,
    padding: Theme.spacing.lg,
    gap: Theme.spacing.xs,
  },
  statLabel: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  statValue: {
    ...Theme.typography.heading,
    color: Theme.colors.foreground,
  },
  meta: {
    gap: Theme.spacing.xs,
  },
  metaText: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 16,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    borderRadius: Theme.radius.lg,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
});
