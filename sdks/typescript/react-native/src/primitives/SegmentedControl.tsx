import { Pressable, StyleSheet, View } from "react-native";
import { useMeasuredRef } from "../frame/measurement";
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
  const trackStyle = [styles.track, { backgroundColor: compact ? colors.hover : colors.surface }];
  const trackRef = useMeasuredRef<View>(testID, trackStyle);
  return (
    <View accessibilityLabel={accessibilityLabel} accessibilityRole="radiogroup" ref={trackRef} style={trackStyle} testID={testID}>
      {options.map((option) => (
        <Segment compact={compact} key={option.value} onChange={onChange} option={option} selected={option.value === value} />
      ))}
    </View>
  );
}

function Segment<TValue extends string>({ option, selected, compact, onChange }: { readonly option: SegmentOption<TValue>; readonly selected: boolean; readonly compact: boolean; readonly onChange: (value: TValue) => void }): React.JSX.Element {
  const { colors } = useTheme();
  const style = [styles.segment, { height: compact ? 30 : 38 }, selected ? (compact ? [{ backgroundColor: colors.popover }, styles.lifted] : { backgroundColor: colors.pressed }) : null];
  const ref = useMeasuredRef<View>(option.testID, style);
  return (
    <Pressable accessibilityLabel={option.label} accessibilityRole="radio" accessibilityState={{ selected, checked: selected }} hitSlop={compact ? 7 : 3} onPress={() => onChange(option.value)} ref={ref} style={style} testID={option.testID}>
      <ChalkText tone={selected ? "text" : "textMuted"} variant={compact ? "button" : "bodyStrong"}>
        {option.label}
      </ChalkText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", padding: 3, borderRadius: 999 },
  segment: { justifyContent: "center", paddingHorizontal: 14, borderRadius: 999 },
  lifted: { boxShadow: fixed.segmentShadow },
});
