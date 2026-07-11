import ArrowRight01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight01Icon";
import CheckmarkCircle01Icon from "@hugeicons/core-free-icons/dist/esm/CheckmarkCircle01Icon";
import Clock01Icon from "@hugeicons/core-free-icons/dist/esm/Clock01Icon";
import Home01Icon from "@hugeicons/core-free-icons/dist/esm/Home01Icon";
import Message01Icon from "@hugeicons/core-free-icons/dist/esm/Message01Icon";
import TextFontIcon from "@hugeicons/core-free-icons/dist/esm/TextFontIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Theme } from "../ui/theme";
import type { NativeEndScreenProps } from "./NativeEndScreen";

export function NativeEndScreenIosPad({ data, onRejoin, onGoHome }: NativeEndScreenProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;

  return (
    <View style={styles.screen}>
      <View style={[styles.content, isLandscape && styles.contentLandscape]}>
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <HugeiconsIcon icon={CheckmarkCircle01Icon} size={40} color={Theme.colors.success} />
          </View>
          <Text style={styles.eyebrow}>Meeting Complete</Text>
          <Text style={styles.title} numberOfLines={2}>
            {data.roomName}
          </Text>
        </View>

        <View style={[styles.statsContainer, isLandscape && styles.statsContainerLandscape]}>
          <StatItem icon={Clock01Icon} isLandscape={isLandscape} label="Duration" value={formatDuration(data.durationSeconds)} />
          <StatItem icon={UserGroupIcon} isLandscape={isLandscape} label="Participants" value={data.participantCount.toString()} />
          <StatItem icon={Message01Icon} isLandscape={isLandscape} label="Messages" value={data.chatCount.toString()} />
          <StatItem icon={TextFontIcon} isLandscape={isLandscape} label="Transcript" value={`${data.transcriptCount} lines`} />
        </View>

        <View style={[styles.actions, isLandscape && styles.actionsLandscape]}>
          <Pressable onPress={onRejoin} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Rejoin Meeting</Text>
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

function StatItem({ icon, label, value, isLandscape }: { icon: any; label: string; value: string; isLandscape?: boolean }): React.JSX.Element {
  return (
    <View style={[styles.statRow, isLandscape && styles.statRowLandscape]}>
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
    maxWidth: 640,
    alignSelf: "center",
  },
  contentLandscape: {
    maxWidth: 900,
  },
  header: {
    alignItems: "center",
    marginBottom: 48,
  },
  iconCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(34, 197, 94, 0.1)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
    borderWidth: 1,
    borderColor: "rgba(34, 197, 94, 0.2)",
  },
  eyebrow: {
    color: Theme.colors.success,
    fontSize: 14,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 2,
    marginBottom: 12,
  },
  title: {
    color: "white",
    fontSize: 42,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -1,
  },
  statsContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 32,
    padding: 32,
    gap: 32,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    marginBottom: 48,
    justifyContent: "space-between",
  },
  statsContainerLandscape: {
    padding: 40,
    gap: 24,
  },
  statRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    width: "45%",
  },
  statRowLandscape: {
    width: "22%",
  },
  statIconBox: {
    width: 52,
    height: 52,
    borderRadius: 16,
    backgroundColor: "rgba(27, 182, 166, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  statTextContainer: {
    flex: 1,
  },
  statLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 4,
  },
  statValue: {
    color: "white",
    fontSize: 20,
    fontWeight: "800",
  },
  actions: {
    flexDirection: "row",
    gap: 16,
  },
  actionsLandscape: {
    maxWidth: 540,
    alignSelf: "center",
    width: "100%",
  },
  primaryButton: {
    flex: 1.5,
    backgroundColor: Theme.colors.primary,
    height: 68,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  primaryButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
  },
  secondaryButton: {
    flex: 1,
    height: 68,
    borderRadius: 24,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  secondaryButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "700",
  },
});
