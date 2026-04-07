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
    <View style={styles.topBarLayer}>
      {/* Identity Pod */}
      <View style={styles.pod}>
        <View style={styles.connectionDot} />
        <Text style={styles.roomName} numberOfLines={1}>{roomName}</Text>
        <View style={styles.divider} />
        <Text style={styles.duration}>{formattedDuration}</Text>
      </View>

      {/* Presence Pod */}
      <View style={styles.pod}>
        <HugeiconsIcon icon={UserGroupIcon} size={18} color={Theme.colors.primary} />
        <Text style={styles.count}>{participantCount}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBarLayer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 54 : 32,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 100,
  },
  pod: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 10, 12, 0.85)",
    borderRadius: 24,
    paddingHorizontal: 20,
    height: 48,
    gap: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.colors.success,
    shadowColor: Theme.colors.success,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 6,
  },
  roomName: {
    color: "white",
    fontSize: 16,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  divider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  duration: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  count: {
    color: "white",
    fontSize: 15,
    fontWeight: "800",
  },
});

