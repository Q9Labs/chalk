import { createFacehashScene, getColor, getForegroundColor, type Intensity3D } from "@q9labsai/facehash";
import { memo, useCallback, useEffect, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Animated, { cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming, type SharedValue } from "react-native-reanimated";
import Svg, { G, Path, Text as SvgText } from "react-native-svg";
import { timings } from "../motion/motion";
import { easings, identityColors } from "../theme/tokens";

export type FaceAvatarProps = {
  readonly name: string;
  readonly size: number;
  /** `bold` is the 3D style for tiles; `subtle` is for rows, pills, chat and toasts. */
  readonly style?: "bold" | "subtle";
  /** Live speaking level from 0 to 1. While it moves, the face bobs and the mouth opens. */
  readonly level?: SharedValue<number>;
  /** Eyes drift on their own every 1.8 s, as on the mockup's touch devices. Off for small avatars. */
  readonly lookAround?: boolean;
  readonly testID?: string;
};

const INTENSITY: Readonly<Record<"bold" | "subtle", Intensity3D>> = { bold: "dramatic", subtle: "subtle" };
const MONO = Platform.select({ ios: "Menlo", default: "monospace" });
const FRONT_HOLD_MS = 1400;
const LOOK_INTERVAL_MS = 1800;
const LOOK_MS = 700;
const BOB = 5;
const MOUTH = 0.55;
const CLOSED = 0.05;

/**
 * A Facehash avatar drawn natively. The face blinks on its own rhythm, reacts to the speaking
 * level, and turns to the front for a moment when touched. All motion runs on the UI thread and
 * stops with reduced motion. Decorative: the parent names the person.
 */
export const FaceAvatar = memo(function FaceAvatar({ name, size, style = "subtle", level, lookAround = false, testID }: FaceAvatarProps): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const scene = useMemo(() => createFacehashScene({ name, colorsLength: identityColors.length, intensity3d: INTENSITY[style] }), [name, style]);
  const background = getColor(identityColors, scene.data.colorIndex);
  const foreground = getForegroundColor(background);
  const geometry = scene.faceGeometry;
  const box = scene.faceBox;
  const eyeCenter = box.y + geometry.leftEyeAnchor.y * (box.height / geometry.viewBox.height);
  const unit = size / 100;
  const projection = scene.projection;

  const turned = useSharedValue(1);
  const blink = useSharedValue(1);
  const lookX = useSharedValue(0);
  const lookY = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) {
      blink.value = 1;
      return;
    }
    const { delay, duration } = scene.data.blinkTimings.left;
    const total = duration * 1000;
    const close = { duration: total * 0.04, easing: easings.standard };
    blink.value = withDelay(delay * 1000, withRepeat(withSequence(withDelay(total * 0.92, withTiming(CLOSED, close)), withTiming(1, close)), -1));
    return () => cancelAnimation(blink);
  }, [blink, reduceMotion, scene]);

  useEffect(() => {
    if (!lookAround || reduceMotion) return;
    const timer = setInterval(() => {
      if (Math.random() < 0.5 || turned.value < 1) return;
      lookX.value = withTiming((Math.random() * 2 - 1) * 6, { duration: LOOK_MS, easing: easings.standard });
      lookY.value = withTiming((Math.random() * 2 - 1) * 4, { duration: LOOK_MS, easing: easings.standard });
    }, LOOK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [lookAround, lookX, lookY, reduceMotion, turned]);

  const turnToFront = useCallback(() => {
    if (reduceMotion) return;
    turned.value = withSequence(withTiming(0, timings.avatarTurn), withDelay(FRONT_HOLD_MS, withTiming(1, timings.avatarTurn)));
    lookX.value = withTiming(0, { duration: 250, easing: easings.standard });
    lookY.value = withTiming(0, { duration: 250, easing: easings.standard });
    blink.value = withSequence(withTiming(CLOSED, { duration: 150, easing: easings.standard }), withTiming(1, { duration: 150, easing: easings.standard }));
  }, [blink, lookX, lookY, reduceMotion, turned]);

  const bobStyle = useAnimatedStyle(() => ({ transform: [{ translateY: level ? -level.value * BOB * unit : 0 }] }));
  const poseStyle = useAnimatedStyle(() => {
    const t = turned.value;
    return {
      transform: [{ translateX: projection.translateX * unit * t }, { translateY: projection.translateY * unit * t }, { skewX: `${projection.skewX * t}deg` }, { skewY: `${projection.skewY * t}deg` }, { scaleX: 1 + (projection.scaleX - 1) * t }, { scaleY: 1 + (projection.scaleY - 1) * t }],
    };
  });
  const eyesLookStyle = useAnimatedStyle(() => ({ transform: [{ translateX: lookX.value * unit }, { translateY: lookY.value * unit }] }));
  const mouthLookStyle = useAnimatedStyle(() => ({ transform: [{ translateX: (lookX.value / 2) * unit }, { translateY: (lookY.value / 2) * unit }] }));
  const blinkStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: blink.value }] }));
  const mouthStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: 1 + (level ? level.value : 0) * MOUTH }] }));

  const faceTransform = `translate(${box.x} ${box.y}) scale(${box.width / geometry.viewBox.width} ${box.height / geometry.viewBox.height})`;

  return (
    <View onTouchStart={turnToFront} style={[styles.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: background }]} testID={testID}>
      <Animated.View style={[StyleSheet.absoluteFill, bobStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, poseStyle]}>
          <Animated.View style={[StyleSheet.absoluteFill, eyesLookStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, { transformOrigin: `50% ${eyeCenter}%` }, blinkStyle]}>
              <Svg height={size} viewBox="0 0 100 100" width={size}>
                <G transform={faceTransform}>
                  {[...geometry.leftEyePaths, ...geometry.rightEyePaths].map((d) => (
                    <Path d={d} fill={foreground} key={d} />
                  ))}
                </G>
              </Svg>
            </Animated.View>
          </Animated.View>
          <Animated.View style={[StyleSheet.absoluteFill, mouthLookStyle]}>
            <Animated.View style={[StyleSheet.absoluteFill, styles.mouthOrigin, mouthStyle]}>
              <Svg height={size} viewBox="0 0 100 100" width={size}>
                <SvgText alignmentBaseline="middle" fill={foreground} fontFamily={MONO} fontSize={scene.initialLayout.fontSize} fontWeight="700" textAnchor="middle" x={scene.initialLayout.x} y={scene.initialLayout.y}>
                  {scene.data.initial}
                </SvgText>
              </Svg>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  circle: { overflow: "hidden" },
  // The initial sits on y = 70 with a 26-unit font, so its baseline is near y = 79.
  mouthOrigin: { transformOrigin: "50% 79%" },
});
