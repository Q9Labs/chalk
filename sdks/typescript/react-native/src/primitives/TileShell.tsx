import { memo, useEffect, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from "react-native-reanimated";
import { useDeviceLayout } from "../frame/device-layout";
import { timings } from "../motion/motion";
import { useTheme } from "../theme/theme";
import { fixed, radii } from "../theme/tokens";

export type TileShellProps = {
  readonly children: ReactNode;
  /** The live ring shows only on a speaking person whose camera is on; a camera-off face reacts instead. */
  readonly speaking?: boolean;
  readonly cameraOn?: boolean;
  /** Speaking level from 0 to 1; the ring's opacity follows it (0.3 + 0.7 × level). */
  readonly level?: SharedValue<number>;
  readonly testID?: string;
};

/**
 * A stage tile's frame (`.tile`): tile surface, 12 pt radius (14 pt on a phone), clipped
 * content, and the live ring drawn over the video. The stage fills it with video or an
 * avatar and a `NameTag`.
 */
export const TileShell = memo(function TileShell({ children, speaking = false, cameraOn = false, level, testID }: TileShellProps): React.JSX.Element {
  const { colors } = useTheme();
  const { phone } = useDeviceLayout();
  const radius = phone ? radii.tilePhone : radii.tile;
  const live = useSharedValue(0);
  const showRing = speaking && cameraOn;
  useEffect(() => {
    live.value = withTiming(showRing ? 1 : 0, timings.scrim);
  }, [live, showRing]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: live.value * (0.3 + 0.7 * (level ? level.value : 1)) }));

  return (
    <View style={[styles.tile, { borderRadius: radius, backgroundColor: colors.tile }]} testID={testID}>
      {children}
      <Animated.View pointerEvents="none" style={[styles.ring, { borderRadius: radius }, ringStyle]} testID={testID ? `${testID}-ring` : undefined}>
        <View style={[styles.ringShade, { borderRadius: radius - 3 }]} />
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  tile: { flex: 1, overflow: "hidden" },
  // `inset 0 0 0 3px` white and `inset 0 0 0 4px` shade in the mockup: a 3 pt white band with a 1 pt shade inside it.
  ring: { ...StyleSheet.absoluteFillObject, borderWidth: 3, borderColor: fixed.liveRing, zIndex: 5 },
  ringShade: { ...StyleSheet.absoluteFillObject, borderWidth: 1, borderColor: fixed.liveRingShade },
});
