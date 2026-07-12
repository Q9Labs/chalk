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
  const pulseAnimation = Animated.loop(Animated.sequence([Animated.timing(pulseAnim, { toValue: 1.1, duration: 2500, easing: Easing.inOut(Easing.ease), useNativeDriver: true }), Animated.timing(pulseAnim, { toValue: 1, duration: 2500, easing: Easing.inOut(Easing.ease), useNativeDriver: true })]));
  const fadeAnimation = Animated.timing(fadeAnim, {
    toValue: 1,
    duration: 800,
    useNativeDriver: true,
  });

  return {
    pulseAnim,
    fadeAnim,
    ref: createAnimationRefController(() => [pulseAnimation, fadeAnimation]),
  };
}
