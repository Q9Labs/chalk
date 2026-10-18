import { StyleSheet, View } from "react-native";
import { ChalkText } from "../primitives/ChalkText";
import { PillButton } from "../primitives/PillButton";
import { useTheme } from "../theme/theme";

export type StatusPageProps = {
  readonly title: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
};

/**
 * A full-screen status page on the canvas (owned by the states lane): left, ended, failed and the
 * rest. This minimal version shows a title, a line and one action.
 */
export function StatusPage({ title, detail, action }: StatusPageProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View accessibilityViewIsModal style={[styles.page, { backgroundColor: colors.canvas }]} testID="chalk-status">
      <ChalkText accessibilityRole="header" style={styles.center} variant="statusTitle">
        {title}
      </ChalkText>
      {detail ? (
        <ChalkText style={styles.center} tone="textMuted">
          {detail}
        </ChalkText>
      ) : null}
      {action ? <PillButton label={action.label} onPress={action.onPress} testID="chalk-status-action" variant="primary" /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  center: { textAlign: "center" },
});
