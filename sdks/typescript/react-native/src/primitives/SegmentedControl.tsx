import { Pressable, StyleSheet, View } from "react-native";
import { useTheme } from "../theme/theme";
import { fixed } from "../theme/tokens";
import { ChalkText } from "./ChalkText";

export type SegmentOption<TValue extends string> = {
  readonly value: TValue;
  readonly label: string;
  readonly testID?: string;
};

export type SegmentedControlProps<TValue extends string> = {
  readonly options: readonly SegmentOption<TValue>[];
  readonly value: TValue;
  readonly onChange: (value: TValue) => void;
  readonly accessibilityLabel: string;
  /** `regular` is the sheet row control (38 pt segments); `compact` is the call details one (30 pt). */
  readonly size?: "regular" | "compact";
  readonly testID?: string;
};

/** The mockup's segmented control (`.seg2`). The selected segment lifts onto a brighter surface. */
export function SegmentedControl<TValue extends string>({ options, value, onChange, accessibilityLabel, size = "regular", testID }: SegmentedControlProps<TValue>): React.JSX.Element {
  const { colors } = useTheme();
  const compact = size === "compact";
  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="radiogroup" style={[styles.track, { backgroundColor: compact ? colors.hover : colors.surface }]} testID={testID}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="radio"
            accessibilityState={{ selected, checked: selected }}
            hitSlop={compact ? 7 : 3}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.segment, { height: compact ? 30 : 38 }, selected ? (compact ? [{ backgroundColor: colors.popover }, styles.lifted] : { backgroundColor: colors.pressed }) : null]}
            testID={option.testID}
          >
            <ChalkText tone={selected ? "text" : "textMuted"} variant={compact ? "button" : "bodyStrong"}>
              {option.label}
            </ChalkText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", padding: 3, borderRadius: 999 },
  segment: { justifyContent: "center", paddingHorizontal: 14, borderRadius: 999 },
  lifted: { boxShadow: fixed.segmentShadow },
});
