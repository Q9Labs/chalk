import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, { runOnUI, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from "react-native-reanimated";
import { timings } from "./motion";

export type Frame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type MovingFrameProps = {
  readonly frame: Frame;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly testID?: string;
};

/**
 * Places its children in `frame` and, when `frame` changes, moves them there from where they
 * were drawn: the view takes its new box at once and a translate-and-scale transform plays from
 * the old box to identity over 220 ms on the UI thread. The children are never remounted, so a
 * video view inside keeps its surface. A move that starts mid-move begins from the current
 * on-screen box. Reduced motion jumps straight to the new box.
 *
 * Example, a stage tile keyed by participant so React keeps the same view across layouts:
 *
 * ```tsx
 * {tiles.map((tile) => (
 *   <MovingFrame frame={tile.frame} key={tile.participantId} testID={`tile.${tile.participantId}`}>
 *     <TileShell cameraOn={tile.cameraOn} level={tile.level}>
 *       <ParticipantVideo participantId={tile.participantId} />
 *       <NameTag name={tile.name} muted={tile.muted} />
 *     </TileShell>
 *   </MovingFrame>
 * ))}
 * ```
 */
export function MovingFrame({ frame, children, style, testID }: MovingFrameProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const target = useSharedValue<Frame>(frame);
  const from = useSharedValue<Frame>(frame);
  const progress = useSharedValue(1);
  const mounted = useRef(false);

  const { x, y, width, height } = frame;
  // nosemgrep: chalk.forbid-sdk-use-effect -- Keep existing native layout animation lifecycle.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    runOnUI((next: Frame, instant: boolean) => {
      "worklet";
      const t = progress.value;
      const was = target.value;
      const start = from.value;
      const shown: Frame = {
        x: was.x + (start.x - was.x) * (1 - t),
        y: was.y + (start.y - was.y) * (1 - t),
        width: was.width + (start.width - was.width) * (1 - t),
        height: was.height + (start.height - was.height) * (1 - t),
      };
      target.value = next;
      if (instant) {
        from.value = next;
        progress.value = 1;
        return;
      }
      from.value = shown;
      progress.value = 0;
      progress.value = withTiming(1, timings.move);
    })({ x, y, width, height }, reduceMotion);
  }, [x, y, width, height, reduceMotion, from, progress, target]);

  const animatedStyle = useAnimatedStyle(() => {
    "worklet";
    const next = target.value;
    const start = from.value;
    const rest = 1 - progress.value;
    const scaleX = next.width > 0 ? 1 + (start.width / next.width - 1) * rest : 1;
    const scaleY = next.height > 0 ? 1 + (start.height / next.height - 1) * rest : 1;
    return {
      left: next.x,
      top: next.y,
      width: next.width,
      height: next.height,
      transform: [{ translateX: (start.x - next.x) * rest }, { translateY: (start.y - next.y) * rest }, { scaleX }, { scaleY }],
    };
  });

  return (
    <Animated.View style={[styles.frame, style, animatedStyle]} testID={testID}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: { position: "absolute", transformOrigin: "left top" },
});
