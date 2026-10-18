import { useCallback } from "react";
import { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { pressScale } from "../theme/tokens";
import { timings } from "./motion";

export type PressAnimation = {
  /** 1 while the finger is down, 0 otherwise; flips at once, for instant colour changes. */
  readonly down: SharedValue<number>;
  readonly onPressIn: () => void;
  readonly onPressOut: () => void;
  readonly scaleStyle: ReturnType<typeof useAnimatedStyle>;
};

/**
 * The mockup's `:active` press: the control scales down over 150 ms ease-out while its
 * background switches at once. Runs on the UI thread; reduced motion keeps the scale at 1.
 */
export function usePressAnimation(family: keyof typeof pressScale): PressAnimation {
  const down = useSharedValue(0);
  const scale = useSharedValue(1);
  const pressedScale = pressScale[family];
  const onPressIn = useCallback(() => {
    down.value = 1;
    scale.value = withTiming(pressedScale, timings.press);
  }, [down, pressedScale, scale]);
  const onPressOut = useCallback(() => {
    down.value = 0;
    scale.value = withTiming(1, timings.press);
  }, [down, scale]);
  const scaleStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return { down, onPressIn, onPressOut, scaleStyle };
}
