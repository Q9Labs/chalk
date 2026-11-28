import { memo } from "react";
import { StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme";
import { corners, space } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

/** The compact pill that marks an admitted AI participant. */
export const AIBadge = memo(function AIBadge({ testID }: { readonly testID?: string }): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View accessibilityLabel="AI participant" style={[styles.badge, { backgroundColor: colors.info }]} testID={testID}>
      <ChalkText color={colors.canvas} style={styles.text} variant="caption">
        AI
      </ChalkText>
    </View>
  );
});

const styles = StyleSheet.create({
  badge: { flexShrink: 0, alignItems: "center", justifyContent: "center", paddingHorizontal: space[1], paddingVertical: space["0-5"], borderRadius: corners.pill },
  text: { fontWeight: "700" },
});
