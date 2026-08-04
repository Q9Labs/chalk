import { Animated, Easing } from "react-native";
import { createAnimationRefController, type AnimationRefCallback } from "./native-animation-controller";

export interface NativeJoiningLoadingAnimation {
  readonly pulseAnim: Animated.Value;
  readonly fadeAnim: Animated.Value;
  readonly ref: AnimationRefCallback<unknown>;
}

export function createNativeJoiningLoadingAnimation(): NativeJoiningLoadingAnimation {
  const pulseAnim = new Animated.Value(1);
  const fadeAnim = new Animated.Value(0);
  const pulseAnimation = Animated.sequence([Animated.timing(pulseAnim, { toValue: 1.035, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }), Animated.timing(pulseAnim, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true })]);
  const fadeAnimation = Animated.timing(fadeAnim, {
    toValue: 1,
    duration: 280,
    easing: Easing.out(Easing.cubic),
    useNativeDriver: true,
  });

  return {
    pulseAnim,
    fadeAnim,
    ref: createAnimationRefController(() => [pulseAnimation, fadeAnimation]),
  };
}
