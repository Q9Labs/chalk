/**
 * EndScreen - Simple end-of-meeting summary for React Native
 */

import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { CHALK_THEME } from "../../theme";

interface EndScreenProps {
  roomId: string;
  duration: number;
  participantCount: number;
  onRejoin: () => void;
  onLeave: () => void;
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

export function EndScreen({ roomId, duration, participantCount, onRejoin, onLeave }: EndScreenProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Meeting ended</Text>
      <Text style={styles.subtitle}>Room {roomId}</Text>

      <View style={styles.stats}>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Duration</Text>
          <Text style={styles.statValue}>{formatDuration(duration)}</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statLabel}>Participants</Text>
          <Text style={styles.statValue}>{participantCount}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <TouchableOpacity style={styles.primaryButton} onPress={onRejoin} activeOpacity={0.8}>
          <Text style={styles.primaryButtonText}>Rejoin</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryButton} onPress={onLeave} activeOpacity={0.8}>
          <Text style={styles.secondaryButtonText}>Exit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: CHALK_THEME.colors.background,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: CHALK_THEME.spacing.lg,
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    color: CHALK_THEME.colors.text.primary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: CHALK_THEME.colors.text.muted,
    marginBottom: 32,
  },
  stats: {
    width: "100%",
    backgroundColor: CHALK_THEME.colors.surface,
    borderRadius: CHALK_THEME.borderRadius.lg,
    padding: CHALK_THEME.spacing.md,
    marginBottom: 24,
  },
  statItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 8,
  },
  statLabel: {
    fontSize: 14,
    color: CHALK_THEME.colors.text.muted,
  },
  statValue: {
    fontSize: 16,
    fontWeight: "600",
    color: CHALK_THEME.colors.text.primary,
  },
  actions: {
    width: "100%",
    gap: 12,
  },
  primaryButton: {
    backgroundColor: CHALK_THEME.colors.primary,
    paddingVertical: 14,
    borderRadius: CHALK_THEME.borderRadius.md,
    alignItems: "center",
  },
  primaryButtonText: {
    color: CHALK_THEME.colors.text.inverse,
    fontSize: 16,
    fontWeight: "600",
  },
  secondaryButton: {
    backgroundColor: CHALK_THEME.colors.ui.pillBg,
    paddingVertical: 14,
    borderRadius: CHALK_THEME.borderRadius.md,
    alignItems: "center",
  },
  secondaryButtonText: {
    color: CHALK_THEME.colors.text.secondary,
    fontSize: 16,
    fontWeight: "600",
  },
});
