import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { ChalkText } from "../primitives/ChalkText";
import { useTheme } from "../theme/theme";

export type LimboProps = {
  /** The progress line, such as "Joining" or "Reconnecting". */
  readonly message: string;
};

/**
 * The limbo overlay (owned by the states lane): a card over the call while it joins or
 * reconnects. This minimal version shows the spinner and one line.
 */
export function Limbo({ message }: LimboProps): React.JSX.Element {
  const { colors } = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={styles.limbo} testID="frame.limbo">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.line }]}>
        <View style={styles.row}>
          <Spinner />
          <ChalkText variant="progress">{message}</ChalkText>
        </View>
      </View>
    </View>
  );
}

/** `.spin`: an 18 pt ring with a bright quarter, one turn every 0.9 s; still with reduced motion. */
function Spinner(): React.JSX.Element {
  const { colors } = useTheme();
  const reduceMotion = useReducedMotion();
  const turn = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    turn.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1);
    return () => cancelAnimation(turn);
  }, [reduceMotion, turn]);
  const style = useAnimatedStyle(() => {
    "worklet";
    return { transform: [{ rotate: `${turn.value * 360}deg` }] };
  });
  return <Animated.View style={[styles.spinner, { borderColor: colors.lineStrong, borderTopColor: reduceMotion ? colors.textMuted : colors.text }, style]} />;
}

const styles = StyleSheet.create({
  limbo: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  card: { alignItems: "center", gap: 8, paddingVertical: 22, paddingHorizontal: 28, borderWidth: 1, borderRadius: 16 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  spinner: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
});
