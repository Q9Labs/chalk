import { Pressable, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { 
  Clock01Icon, 
  UserGroupIcon, 
  Message01Icon, 
  TextFontIcon,
  CheckmarkCircle01Icon
} from "@hugeicons/core-free-icons";
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
        <View style={styles.iconContainer}>
          <View style={styles.iconGlow} />
          <HugeiconsIcon icon={CheckmarkCircle01Icon} size={48} color="#22c55e" />
        </View>
        
        <Text style={styles.eyebrow}>You've left the meeting</Text>
        <Text style={styles.title} numberOfLines={2}>{data.roomName}</Text>
        
        <View style={styles.statsGrid}>
          <View style={styles.statCard}>
            <HugeiconsIcon icon={Clock01Icon} size={20} color={Theme.colors.mutedForeground} />
            <Text style={styles.statValue}>{formatDuration(data.durationSeconds)}</Text>
            <Text style={styles.statLabel}>Duration</Text>
          </View>
          <View style={styles.statCard}>
            <HugeiconsIcon icon={UserGroupIcon} size={20} color={Theme.colors.mutedForeground} />
            <Text style={styles.statValue}>{data.participantCount}</Text>
            <Text style={styles.statLabel}>People</Text>
          </View>
          <View style={styles.statCard}>
            <HugeiconsIcon icon={Message01Icon} size={20} color={Theme.colors.mutedForeground} />
            <Text style={styles.statValue}>{data.chatCount}</Text>
            <Text style={styles.statLabel}>Messages</Text>
          </View>
          <View style={styles.statCard}>
            <HugeiconsIcon icon={TextFontIcon} size={20} color={Theme.colors.mutedForeground} />
            <Text style={styles.statValue}>{data.transcriptCount}</Text>
            <Text style={styles.statLabel}>Lines</Text>
          </View>
        </View>

        <View style={styles.actions}>
          <Pressable onPress={onRejoin} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Rejoin meeting</Text>
          </Pressable>
          <Pressable onPress={onGoHome} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Back to home</Text>
          </Pressable>
        </View>
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
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 32,
    backgroundColor: "#131927",
    padding: 32,
    alignItems: "center",
    gap: 20,
  },
  iconContainer: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    width: 80,
    height: 80,
    marginBottom: 8,
  },
  iconGlow: {
    position: "absolute",
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: "#22c55e",
    opacity: 0.15,
    transform: [{ scale: 1.5 }],
  },
  eyebrow: {
    color: "#22c55e",
    fontSize: 14,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.5,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    width: "100%",
    marginTop: 8,
    marginBottom: 8,
  },
  statCard: {
    flex: 1,
    minWidth: "45%",
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.3)",
    padding: 16,
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.04)",
  },
  statLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    fontWeight: "600",
  },
  statValue: {
    color: Theme.colors.foreground,
    fontSize: 20,
    fontWeight: "700",
  },
  actions: {
    width: "100%",
    gap: 12,
    marginTop: 8,
  },
  primaryButton: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#22c55e",
    borderRadius: 24,
    height: 56,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  secondaryButton: {
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    backgroundColor: "transparent",
    height: 56,
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "700",
  },
});
