import SecurityCheckIcon from "@hugeicons/core-free-icons/dist/esm/SecurityCheckIcon";
import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";
import { useNativeAppearance } from "../../ui/native-appearance-context";
import { ChalkLogoElements } from "../ChalkLogoElements";

export interface MeetingTopBarProps {
  roomName: string;
  participantCount: number;
  formattedDuration: string;
}

export function MeetingTopBarAndroid({ roomName, participantCount, formattedDuration }: MeetingTopBarProps): React.JSX.Element {
  const { appearance } = useNativeAppearance();
  const tokens = appearance.tokens;
  return (
    <View style={[styles.topBar, { backgroundColor: tokens.chrome, borderColor: tokens.line }]}>
      <View style={styles.topBarLeft}>
        <ChalkLogoElements size={28} />
        <View style={[styles.divider, { backgroundColor: tokens.line }]} />
        <Text style={[styles.topBarRoomName, { color: tokens.text }]} numberOfLines={1}>
          {roomName}
        </Text>
        <Text style={[styles.timerText, { color: tokens.textMuted }]}>{formattedDuration}</Text>
      </View>
      <View style={styles.topBarRight}>
        <View style={styles.secureState}>
          <HugeiconsIcon color={Theme.colors.success} icon={SecurityCheckIcon} size={16} />
          <Text style={styles.secureText}>Secure</Text>
        </View>
        <View style={[styles.participantCount, { backgroundColor: tokens.control, borderColor: tokens.line }]}>
          <HugeiconsIcon color={tokens.text} icon={UserGroupIcon} size={16} />
          <Text style={[styles.topBarCount, { color: tokens.text }]}>{participantCount}</Text>
        </View>
      </View>
    </View>
  );
}

export { MeetingTopBarAndroid as MeetingTopBar };

const styles = StyleSheet.create({
  topBar: {
    paddingTop: Platform.OS === "ios" ? 48 : 30,
    paddingBottom: 12,
    paddingHorizontal: Theme.spacing.lg,
    backgroundColor: Theme.colors.surfaceMuted,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: Theme.colors.border,
    width: "100%",
  },
  topBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    flex: 1,
    minWidth: 0,
  },
  divider: {
    width: 1,
    height: 24,
    backgroundColor: Theme.colors.border,
    marginHorizontal: 2,
  },
  topBarRoomName: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: -0.2,
    flexShrink: 1,
  },
  timerText: {
    color: Theme.colors.inkTertiary,
    fontSize: 11,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    flexShrink: 0,
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    marginLeft: Theme.spacing.sm,
  },
  secureState: { flexDirection: "row", alignItems: "center", gap: 4 },
  secureText: { color: Theme.colors.success, fontSize: 11, fontWeight: "600" },
  participantCount: {
    minWidth: 40,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: Theme.radius.sm,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  topBarCount: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
});
