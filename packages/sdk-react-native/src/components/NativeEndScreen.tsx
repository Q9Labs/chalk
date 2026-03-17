import { Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Clock01Icon, UserGroupIcon, Message01Icon, TextFontIcon, CheckmarkCircle01Icon, ArrowRight01Icon, Home01Icon } from "@hugeicons/core-free-icons";
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
      <View style={styles.content}>
        {/* Success Header */}
        <View style={styles.header}>
          <View style={styles.iconCircle}>
            <HugeiconsIcon icon={CheckmarkCircle01Icon} size={40} color={Theme.colors.success} />
          </View>
          <Text style={styles.eyebrow}>Meeting Complete</Text>
          <Text style={styles.title} numberOfLines={2}>
            {data.roomName}
          </Text>
        </View>

        {/* Stats Grid - Cleaner, more integrated */}
        <View style={styles.statsContainer}>
          <StatItem icon={Clock01Icon} label="Duration" value={formatDuration(data.durationSeconds)} />
          <StatItem icon={UserGroupIcon} label="Participants" value={data.participantCount.toString()} />
          <StatItem icon={Message01Icon} label="Messages" value={data.chatCount.toString()} />
          <StatItem icon={TextFontIcon} label="Transcript" value={`${data.transcriptCount} lines`} />
        </View>

        {/* Actions */}
        <View style={styles.actions}>
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

function StatItem({ icon, label, value }: { icon: any; label: string; value: string }) {
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

function formatDuration(seconds: number) {
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
    backgroundColor: "rgba(34, 197, 94, 0.1)",
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
    color: "white",
    fontSize: 32,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  statsContainer: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 24,
    padding: 24,
    gap: 20,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
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
    backgroundColor: "rgba(27, 182, 166, 0.1)",
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
    color: "white",
    fontSize: 17,
    fontWeight: "700",
  },
  actions: {
    gap: 12,
  },
  primaryButton: {
    backgroundColor: Theme.colors.primary,
    height: 64,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 15,
    elevation: 8,
  },
  primaryButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
  },
  secondaryButton: {
    height: 60,
    borderRadius: 20,
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
