import UserGroupIcon from "@hugeicons/core-free-icons/dist/esm/UserGroupIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Image, Platform, StyleSheet, Text, View } from "react-native";
import { Theme } from "../../ui/theme";
import { useNativeTheme } from "../../ui/native-theme";

export interface SpaceTopBarProps {
  spaceName: string;
  participantCount: number;
  formattedDuration: string;
  logoUrl?: string;
}

export function SpaceTopBarAndroid({ spaceName, participantCount, formattedDuration, logoUrl }: SpaceTopBarProps): React.JSX.Element {
  const theme = useNativeTheme();
  return (
    <View style={[styles.topBar, { backgroundColor: theme.colors.darkCanvas, borderColor: theme.colors.border }]}>
      <View style={styles.topBarLeft}>
        {logoUrl ? <Image accessibilityLabel="Chalk" source={{ uri: logoUrl }} style={styles.logo} /> : null}
        <View style={[styles.connectionDot, { backgroundColor: theme.colors.success }]} />
        <Text style={[styles.topBarSpaceName, { color: theme.colors.foreground }]} numberOfLines={1}>
          {spaceName}
        </Text>
        <View style={[styles.timerBadge, { backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.timerText, { color: theme.colors.mutedForeground }]}>{formattedDuration}</Text>
        </View>
      </View>
      <View style={[styles.topBarRight, { backgroundColor: theme.colors.surface }]}>
        <HugeiconsIcon icon={UserGroupIcon} size={14} color={theme.colors.foreground} />
        <Text style={[styles.topBarCount, { color: theme.colors.foreground }]}>{participantCount}</Text>
      </View>
    </View>
  );
}

export { SpaceTopBarAndroid as SpaceTopBar };

const styles = StyleSheet.create({
  topBar: {
    paddingTop: Platform.OS === "ios" ? 54 : 42,
    paddingBottom: 14,
    paddingHorizontal: 24,
    backgroundColor: Theme.colors.darkCanvas,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderColor: Theme.colors.whiteOverlay06,
    width: "100%",
  },
  topBarLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  logo: { width: 24, height: 24, borderRadius: 6 },
  connectionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Theme.colors.success,
  },
  topBarSpaceName: {
    color: Theme.colors.onDark,
    fontSize: 14,
    fontWeight: "800",
    letterSpacing: -0.2,
  },
  timerBadge: {
    backgroundColor: Theme.colors.whiteOverlay10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  timerText: {
    color: Theme.colors.whiteOverlay60,
    fontSize: 11,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  topBarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Theme.colors.whiteOverlay08,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
  },
  topBarCount: {
    color: Theme.colors.onDark,
    fontSize: 12,
    fontWeight: "800",
  },
});
