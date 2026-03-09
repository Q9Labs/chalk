/**
 * AudioIndicator - Animated bars for speaking visualization
 */

import { useEffect } from "react";
import { View, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, withRepeat, withSequence, cancelAnimation, Easing } from "react-native-reanimated";
import { CHALK_THEME } from "../../theme";

interface AudioIndicatorProps {
  /** Audio level from 0 to 1 */
  level: number;
  /** Whether audio is active */
  isActive: boolean;
  /** Size of the indicator container (default: 24) */
  size?: number;
}

/** Base heights for bars as fractions of container height */
const BAR_HEIGHTS: readonly number[] = [0.4, 0.7, 0.5];

/** Animation phase offsets for each bar */
const PHASE_OFFSETS: readonly number[] = [0, 100, 50];

export function AudioIndicator({ level, isActive, size = 24 }: AudioIndicatorProps) {
  const bar0Height = useSharedValue(0.4);
  const bar1Height = useSharedValue(0.7);
  const bar2Height = useSharedValue(0.5);

  const barHeights = [bar0Height, bar1Height, bar2Height];

  useEffect(() => {
    if (isActive && level > 0.05) {
      // Animate bars based on level
      const amplitude = level * 0.5;
      const duration = 150 - level * 50; // Faster when louder

      for (const [i, height] of barHeights.entries()) {
        const baseHeight = BAR_HEIGHTS[i] ?? 0.5;
        const minHeight = Math.max(0.2, baseHeight - amplitude);
        const maxHeight = Math.min(1, baseHeight + amplitude);
        const offset = PHASE_OFFSETS[i] ?? 0;

        setTimeout(() => {
          height.value = withRepeat(
            withSequence(
              withTiming(maxHeight, {
                duration,
                easing: Easing.inOut(Easing.ease),
              }),
              withTiming(minHeight, {
                duration,
                easing: Easing.inOut(Easing.ease),
              }),
            ),
            -1,
            true,
          );
        }, offset);
      }
    } else {
      // Reset to base heights
      for (const [i, height] of barHeights.entries()) {
        cancelAnimation(height);
        const targetHeight = BAR_HEIGHTS[i] ?? 0.5;
        height.value = withTiming(targetHeight, { duration: 200 });
      }
    }

    return () => {
      for (const height of barHeights) {
        cancelAnimation(height);
      }
    };
  }, [isActive, level]);

  const barWidth = Math.max(2, size / 6);
  const gap = Math.max(2, size / 8);

  const animatedStyle0 = useAnimatedStyle(() => ({
    height: bar0Height.value * size,
  }));

  const animatedStyle1 = useAnimatedStyle(() => ({
    height: bar1Height.value * size,
  }));

  const animatedStyle2 = useAnimatedStyle(() => ({
    height: bar2Height.value * size,
  }));

  const animatedStyles = [animatedStyle0, animatedStyle1, animatedStyle2];
  const barColor = isActive ? CHALK_THEME.colors.status.speaking : CHALK_THEME.colors.text.muted;

  return (
    <View style={[styles.container, { width: size, height: size, gap }]}>
      {BAR_HEIGHTS.map((_, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            {
              width: barWidth,
              backgroundColor: barColor,
              borderRadius: barWidth / 2,
            },
            animatedStyles[i],
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    minHeight: 4,
  },
});
