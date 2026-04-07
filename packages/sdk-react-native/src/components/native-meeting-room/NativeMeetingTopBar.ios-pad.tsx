import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";

export interface NativeMeetingTopBarProps {
  roomName: string;
  participantCount: number;
  formattedDuration: string;
}

export function NativeMeetingTopBarIosPad({ roomName, participantCount, formattedDuration }: NativeMeetingTopBarProps): React.JSX.Element {
  return (
    <View style={styles.hudLayer}>
      {/* Left HUD: Room & Time */}
      <View style={styles.hudGroup}>
        <View style={styles.statusDot} />
        <Text style={styles.roomText}>{roomName}</Text>
        <Text style={styles.timeText}>{formattedDuration}</Text>
      </View>

      {/* Right HUD: Presence */}
      <View style={styles.hudGroup}>
        <HugeiconsIcon icon={UserGroupIcon} size={16} color="rgba(255,255,255,0.7)" />
        <Text style={styles.countText}>{participantCount}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hudLayer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 44 : 24,
    left: 32,
    right: 32,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 100,
  },
  hudGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.colors.success,
    shadowColor: Theme.colors.success,
    shadowOpacity: 1,
    shadowRadius: 6,
  },
  roomText: {
    color: "white",
    fontSize: 14,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  timeText: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  countText: {
    color: "white",
    fontSize: 14,
    fontWeight: "800",
    textShadowColor: "rgba(0,0,0,0.5)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
});


