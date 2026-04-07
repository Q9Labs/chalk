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

const styles = StyleSheet.create({
  topBar: {
    paddingTop: Platform.OS === "ios" ? 64 : 48,
    paddingBottom: 16,
    paddingHorizontal: 32,
    backgroundColor: "rgba(0,0,0,0.6)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    width: "100%",
    position: "absolute",
    top: 0,
    zIndex: 100,
  },
  topBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.colors.success,
    shadowColor: Theme.colors.success,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  topBarRoomName: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.4,
  },
  timerBadge: {
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
    marginLeft: 8,
  },
  timerText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  topBarCount: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
});
