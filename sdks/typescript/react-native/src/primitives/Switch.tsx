import { memo, useEffect } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { timings } from "../motion/motion";
import { useTheme } from "../theme/theme";
import { fixed } from "../theme/tokens";

export type SwitchProps = {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly accessibilityLabel: string;
  readonly testID?: string;
};

/** The mockup's switch (`.sw`): a 36 by 22 track, green when on, with a knob that slides 14 pt in 150 ms. */
export const Switch = memo(function Switch({ value, onValueChange, accessibilityLabel, testID }: SwitchProps): React.JSX.Element {
  const { colors } = useTheme();
  const on = useSharedValue(value ? 1 : 0);
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native switch animation.
  useEffect(() => {
    on.value = withTiming(value ? 1 : 0, timings.switch);
  }, [on, value]);
  const knobStyle = useAnimatedStyle(() => {
    "worklet";
    return { transform: [{ translateX: on.value * 14 }] };
  });

  return (
    <Pressable accessibilityLabel={accessibilityLabel} accessibilityRole="switch" accessibilityState={{ checked: value }} hitSlop={11} onPress={() => onValueChange(!value)} testID={testID}>
      <Animated.View style={[styles.track, { backgroundColor: value ? colors.success : colors.pressed }]}>
        <Animated.View style={[styles.knob, knobStyle]} />
      </Animated.View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  track: { width: 36, height: 22, borderRadius: 999 },
  knob: { position: "absolute", left: 3, top: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: fixed.switchKnob },
});
