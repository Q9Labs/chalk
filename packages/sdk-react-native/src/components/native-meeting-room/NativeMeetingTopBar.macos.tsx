import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";

export interface NativeMeetingTopBarProps {
  roomName: string;
  participantCount: number;
  formattedDuration: string;
}

export function NativeMeetingTopBarMacos({ roomName, participantCount, formattedDuration }: NativeMeetingTopBarProps): React.JSX.Element {
  return (
    <View style={styles.topBar}>
      <View style={styles.topBarLeft}>
        <View style={styles.connectionDot} />
        <Text style={styles.topBarRoomName} numberOfLines={1}>
          {roomName}
        </Text>
        <View style={styles.timerBadge}>
          <Text style={styles.timerText}>{formattedDuration}</Text>
        </View>
      </View>
      <View style={styles.topBarRight}>
        <HugeiconsIcon icon={UserGroupIcon} size={14} color="#ffffff" />
        <Text style={styles.topBarCount}>{participantCount}</Text>
      </View>
    </View>
  );
}

export { NativeMeetingTopBarMacos as NativeMeetingTopBar };

const styles = StyleSheet.create({
  topBar: {
    paddingTop: Platform.OS === "ios" ? 54 : 42,
    paddingBottom: 14,
    paddingHorizontal: 24,
    backgroundColor: "#000000",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    width: "100%",
  },
  topBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.colors.success,
  },
  topBarRoomName: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  timerBadge: {
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  timerText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  topBarCount: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
});
