import { Platform, StyleSheet, Text, View } from "react-native";

export interface NativeMeetingTopBarProps {
  roomName: string;
  participantCount: number;
  formattedDuration: string;
}

export function NativeMeetingTopBarIosPad({ roomName, formattedDuration }: NativeMeetingTopBarProps): React.JSX.Element {
  return (
    <View style={styles.hudLayer}>
      {/* Identity Pod: Frost Glass */}
      <View style={styles.roomPill}>
        <Text style={styles.roomText}>{roomName}</Text>
        <View style={styles.divider} />
        <Text style={styles.timeText}>{formattedDuration}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hudLayer: {
    position: "absolute",
    top: Platform.OS === "ios" ? 44 : 24,
    left: 32,
    zIndex: 100,
  },
  roomPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(10, 10, 12, 0.85)",
    borderRadius: 20,
    paddingHorizontal: 16,
    height: 40,
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  roomText: {
    color: "white",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  divider: {
    width: 1,
    height: 14,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  timeText: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 12,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
});



