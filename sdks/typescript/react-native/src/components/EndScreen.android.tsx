import ArrowRight01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight01Icon";
import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/dist/esm/CheckmarkCircle01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/dist/esm/Clock01Icon";
import Home01Icon from "@hugeicons/core-free-icons/dist/esm/Home01Icon";
import Message01Icon from "@hugeicons/core-free-icons/dist/esm/Message01Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";
import type { EndScreenProps } from "./EndScreen";

export function EndScreenAndroid({ data, onRejoin, onGoHome }: EndScreenProps): React.JSX.Element {
  return (
    <View style={styles.screen}>
      <View style={styles.content}>
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <HugeiconsIcon icon={CheckmarkCircle01Icon} size={40} color={Theme.colors.success} />
          </View>
          <Text style={styles.eyebrow}>Episode complete</Text>
          <Text style={styles.title} numberOfLines={2}>
            {data.roomName}
          </Text>
        </View>

        <View style={styles.statsContainer}>
          <StatItem icon={Clock01Icon} label="Duration" value={formatDuration(data.durationSeconds)} />
          <StatItem icon={UserGroupIcon} label="Participants" value={data.participantCount.toString()} />
          <StatItem icon={Message01Icon} label="Messages" value={data.chatCount.toString()} />
        </View>

        <View style={styles.actions}>
          <Pressable onPress={onRejoin} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Return to Space</Text>
            <HugeiconsIcon icon={ArrowRight01Icon} size={20} color="white" />
          </Pressable>

          <Pressable onPress={onGoHome} style={styles.secondaryButton}>
            <HugeiconsIcon icon={Home01Icon} size={20} color={Theme.colors.mutedForeground} />
            <Text style={styles.secondaryButtonText}>Back to Home</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export { EndScreenAndroid as EndScreen };

function StatItem({ icon, label, value }: { icon: any; label: string; value: string }): React.JSX.Element {
  return (
    <View style={styles.statRow}>
      <View style={styles.statIconBox}>
        <HugeiconsIcon icon={icon} size={20} color={Theme.colors.primary} />
      </View>
      <View style={styles.statTextContainer}>
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={styles.statValue}>{value}</Text>
      </View>
    </View>
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m ${String(remainingSeconds).padStart(2, "0")}s`;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  content: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 40,
  },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Theme.colors.successBackground,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  eyebrow: {
    color: Theme.colors.success,
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 32,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  statsContainer: {
    backgroundColor: Theme.colors.surface,
    borderRadius: Theme.radius.lg,
    padding: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    marginBottom: 40,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  statIconBox: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: Theme.colors.washBlue,
    alignItems: "center",
    justifyContent: "center",
  },
  statTextContainer: {
    flex: 1,
  },
  statLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 2,
  },
  statValue: {
    color: Theme.colors.foreground,
    fontSize: 17,
    fontWeight: "700",
  },
  actions: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: Theme.colors.primary,
    height: 54,
    borderRadius: Theme.radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
  },
  secondaryButton: {
    height: 50,
    borderRadius: Theme.radius.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "transparent",
  },
  secondaryButtonText: {
    color: Theme.colors.mutedForeground,
    fontSize: 16,
    fontWeight: "600",
  },
});
