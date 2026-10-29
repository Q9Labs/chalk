import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { useTheme } from "../theme/theme";
import { durations, easings } from "../theme/tokens";

/**
 * How much of the call shows through. The mockup blurs the call (18 pt while joining or
 * knocking, 10 pt and greyed while reconnecting or on hold); without a native blur view the
 * veil covers it with the canvas colour instead.
 */
export type VeilLevel = "none" | "limbo" | "paused";

const OPACITY: Readonly<Record<VeilLevel, number>> = { none: 0, limbo: 0.85, paused: 0.75 };

/** `.veil`: the call lifts out of limbo by fading the canvas from 60 % to nothing over 300 ms. */
const LIFT_FROM = 0.6;

export function Veil({ level }: { readonly level: VeilLevel }): React.JSX.Element {
  const { colors } = useTheme();
  const opacity = useSharedValue(OPACITY[level]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- Keep existing native veil transition lifecycle.
  useEffect(() => {
    if (level !== "none") {
      opacity.value = OPACITY[level];
      return;
    }
    if (opacity.value === 0) return;
    opacity.value = LIFT_FROM;
    opacity.value = withTiming(0, { duration: durations.veil, easing: easings.easeOut, reduceMotion: ReduceMotion.System });
  }, [level, opacity]);
  const style = useAnimatedStyle(() => {
    "worklet";
    return { opacity: opacity.value };
  });
  return <Animated.View pointerEvents={level === "none" ? "none" : "auto"} style={[StyleSheet.absoluteFill, { backgroundColor: colors.canvas }, style]} testID="limbo.veil" />;
}
