import { Children, Fragment, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Icon, type IconName } from "../icons/Icon";
import { useTheme } from "../theme/theme";
import { ChalkText } from "./ChalkText";

/** A rounded group of sheet rows (`.sgrp`), with a hairline between rows. */
export function SheetGroup({ children, testID }: { readonly children: ReactNode; readonly testID?: string }): React.JSX.Element {
  const { colors } = useTheme();
  const rows = Children.toArray(children);
  return (
    <View style={[styles.group, { backgroundColor: colors.raised }]} testID={testID}>
      {rows.map((row, index) => (
        <Fragment key={index}>
          {index > 0 ? <View style={[styles.divider, { backgroundColor: colors.line }]} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

export type SheetRowProps = {
  readonly label: string;
  readonly icon?: IconName;
  /** A control or muted text at the end of the row: a switch, a segmented control, a count. */
  readonly end?: ReactNode;
  /** A mark right after the label, such as the unread dot (`.udot`); the end control stays at the edge. */
  readonly badge?: ReactNode;
  /** What a screen reader says for the row, when the badge adds meaning the label lacks. Defaults to the label. */
  readonly accessibilityLabel?: string;
  /** Makes the whole row a button. Leave it out when the row holds its own control. */
  readonly onPress?: () => void;
  readonly danger?: boolean;
  readonly testID?: string;
};

/** A phone sheet row (`.srow`): 52 pt high, 16 pt text, an optional icon in front and a control at the end. */
export function SheetRow({ label, icon, end, badge, accessibilityLabel = label, onPress, danger = false, testID }: SheetRowProps): React.JSX.Element {
  const { colors } = useTheme();
  const content = (
    <>
      {icon ? <Icon color={danger ? colors.dangerText : colors.textSoft} name={icon} /> : null}
      <ChalkText numberOfLines={1} style={badge ? styles.labelShrink : styles.label} tone={danger ? "dangerText" : "text"} variant="phoneRow">
        {label}
      </ChalkText>
      {badge ? <View style={styles.badge}>{badge}</View> : null}
      {end}
    </>
  );
  if (!onPress) {
    return (
      <View style={styles.row} testID={testID}>
        {content}
      </View>
    );
  }
  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, pressed ? { backgroundColor: colors.pressed } : null]} testID={testID}>
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: 16, overflow: "hidden" },
  divider: { height: 1 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 52, paddingHorizontal: 16 },
  label: { flex: 1 },
  labelShrink: { flexShrink: 1 },
  badge: { marginLeft: 2, marginRight: "auto" },
});
