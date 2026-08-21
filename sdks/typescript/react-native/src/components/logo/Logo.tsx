import { useEffect, useId, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Pressable } from "react-native";
import Svg, { Defs, Ellipse, G, LinearGradient, Path, Stop, Text as SvgText } from "react-native-svg";

const AnimatedG = Animated.createAnimatedComponent(G);

export type LogoMotion = "orbit-burst" | "none";
export type LogoVariant = "mark" | "wordmark";

export interface LogoProps {
  readonly accessibilityLabel?: string | null;
  readonly color?: string;
  readonly height?: number;
  readonly motion?: LogoMotion;
  readonly variant?: LogoVariant;
}

interface InteractionState {
  readonly focus: boolean;
  readonly hover: boolean;
  readonly press: boolean;
}

interface StickAnimationValues {
  readonly rotation: Animated.Value;
  readonly scaleX: Animated.Value;
  readonly scaleY: Animated.Value;
  readonly translateX: Animated.Value;
  readonly translateY: Animated.Value;
}

type StickAnimationValuesTuple = readonly [StickAnimationValues, StickAnimationValues, StickAnimationValues, StickAnimationValues];

interface StickMotion {
  readonly burstRotation: number;
  readonly burstScale: number;
  readonly burstSettleRotation: number;
  readonly burstSettleScale: number;
  readonly burstSettleX: number;
  readonly burstSettleY: number;
  readonly burstX: number;
  readonly burstY: number;
  readonly orbitRotation: readonly [number, number, number, number];
  readonly orbitX: readonly [number, number, number, number];
  readonly orbitY: readonly [number, number, number, number];
  readonly originX: number;
  readonly originY: number;
  readonly transform: string;
}

const STICK_MOTIONS: readonly [StickMotion, StickMotion, StickMotion, StickMotion] = [
  {
    transform: "rotate(-15 20 60)",
    originX: 15,
    originY: 42,
    orbitRotation: [0, -5, 0, 0],
    orbitX: [0, -4, 0, 0],
    orbitY: [0, 3, 0, 0],
    burstRotation: -8,
    burstScale: 1.14,
    burstSettleRotation: 2,
    burstSettleScale: 0.98,
    burstSettleX: -2,
    burstSettleY: 2,
    burstX: -14,
    burstY: -9,
  },
  {
    transform: "rotate(-8 32 55)",
    originX: 29,
    originY: 38,
    orbitRotation: [0, 4, 0, 0],
    orbitX: [0, 3, 0, 0],
    orbitY: [0, -4, 0, 0],
    burstRotation: -4,
    burstScale: 1.14,
    burstSettleRotation: 1,
    burstSettleScale: 0.98,
    burstSettleX: 1,
    burstSettleY: 1,
    burstX: -4,
    burstY: -14,
  },
  {
    transform: "rotate(12 60 30)",
    originX: 42,
    originY: 32,
    orbitRotation: [0, 5, 0, 0],
    orbitX: [0, 5, 0, 0],
    orbitY: [0, 2, 0, 0],
    burstRotation: 8,
    burstScale: 1.16,
    burstSettleRotation: -2,
    burstSettleScale: 0.98,
    burstSettleX: 2,
    burstSettleY: 1,
    burstX: 14,
    burstY: -6,
  },
  {
    transform: "rotate(5 55 50)",
    originX: 55,
    originY: 50,
    orbitRotation: [0, -4, 0, 0],
    orbitX: [0, -3, 0, 0],
    orbitY: [0, -3, 0, 0],
    burstRotation: 7,
    burstScale: 1.13,
    burstSettleRotation: -1,
    burstSettleScale: 0.98,
    burstSettleX: 1,
    burstSettleY: -1,
    burstX: 11,
    burstY: 12,
  },
];

const ORBIT_DURATION = 4800;
const BURST_DURATION = 1100;
const DEFAULT_COLOR = "#1A332B";
const DEFAULT_HEIGHT = 32;
const DEFAULT_MOTION: LogoMotion = "orbit-burst";
const DEFAULT_VARIANT: LogoVariant = "wordmark";
const WORDMARK_VIEW_BOX = "0 0 200 80";
const MARK_VIEW_BOX = "0 0 68 80";

function createStickAnimationValues(): StickAnimationValuesTuple {
  return [
    { rotation: new Animated.Value(0), scaleX: new Animated.Value(1), scaleY: new Animated.Value(1), translateX: new Animated.Value(0), translateY: new Animated.Value(0) },
    { rotation: new Animated.Value(0), scaleX: new Animated.Value(1), scaleY: new Animated.Value(1), translateX: new Animated.Value(0), translateY: new Animated.Value(0) },
    { rotation: new Animated.Value(0), scaleX: new Animated.Value(1), scaleY: new Animated.Value(1), translateX: new Animated.Value(0), translateY: new Animated.Value(0) },
    { rotation: new Animated.Value(0), scaleX: new Animated.Value(1), scaleY: new Animated.Value(1), translateX: new Animated.Value(0), translateY: new Animated.Value(0) },
  ];
}

function createOrbitAnimation(stick: StickAnimationValues, motion: StickMotion, index: number): Animated.CompositeAnimation {
  const keyframes = [
    Animated.parallel([
      Animated.timing(stick.rotation, { duration: ORBIT_DURATION / 2, toValue: motion.orbitRotation[1], useNativeDriver: true }),
      Animated.timing(stick.translateX, { duration: ORBIT_DURATION / 2, toValue: motion.orbitX[1], useNativeDriver: true }),
      Animated.timing(stick.translateY, { duration: ORBIT_DURATION / 2, toValue: motion.orbitY[1], useNativeDriver: true }),
    ]),
    Animated.parallel([
      Animated.timing(stick.rotation, { duration: ORBIT_DURATION / 2, toValue: motion.orbitRotation[2], useNativeDriver: true }),
      Animated.timing(stick.translateX, { duration: ORBIT_DURATION / 2, toValue: motion.orbitX[2], useNativeDriver: true }),
      Animated.timing(stick.translateY, { duration: ORBIT_DURATION / 2, toValue: motion.orbitY[2], useNativeDriver: true }),
    ]),
  ];

  return Animated.sequence([Animated.delay(index * 90), Animated.loop(Animated.sequence(keyframes))]);
}

function createBurstAnimation(stick: StickAnimationValues, motion: StickMotion): Animated.CompositeAnimation {
  return Animated.loop(
    Animated.sequence([
      Animated.parallel([
        Animated.timing(stick.rotation, { duration: BURST_DURATION * 0.24, toValue: motion.burstRotation, useNativeDriver: true }),
        Animated.timing(stick.scaleX, { duration: BURST_DURATION * 0.24, toValue: motion.burstScale, useNativeDriver: true }),
        Animated.timing(stick.scaleY, { duration: BURST_DURATION * 0.24, toValue: motion.burstScale, useNativeDriver: true }),
        Animated.timing(stick.translateX, { duration: BURST_DURATION * 0.24, toValue: motion.burstX, useNativeDriver: true }),
        Animated.timing(stick.translateY, { duration: BURST_DURATION * 0.24, toValue: motion.burstY, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(stick.rotation, { duration: BURST_DURATION * 0.25, toValue: motion.burstSettleRotation, useNativeDriver: true }),
        Animated.timing(stick.scaleX, { duration: BURST_DURATION * 0.25, toValue: motion.burstSettleScale, useNativeDriver: true }),
        Animated.timing(stick.scaleY, { duration: BURST_DURATION * 0.25, toValue: motion.burstSettleScale, useNativeDriver: true }),
        Animated.timing(stick.translateX, { duration: BURST_DURATION * 0.25, toValue: motion.burstSettleX, useNativeDriver: true }),
        Animated.timing(stick.translateY, { duration: BURST_DURATION * 0.25, toValue: motion.burstSettleY, useNativeDriver: true }),
      ]),
      Animated.parallel([
        Animated.timing(stick.rotation, { duration: BURST_DURATION * 0.33, toValue: 0, useNativeDriver: true }),
        Animated.timing(stick.scaleX, { duration: BURST_DURATION * 0.33, toValue: 1, useNativeDriver: true }),
        Animated.timing(stick.scaleY, { duration: BURST_DURATION * 0.33, toValue: 1, useNativeDriver: true }),
        Animated.timing(stick.translateX, { duration: BURST_DURATION * 0.33, toValue: 0, useNativeDriver: true }),
        Animated.timing(stick.translateY, { duration: BURST_DURATION * 0.33, toValue: 0, useNativeDriver: true }),
      ]),
    ]),
  );
}

function resetStickAnimationValues(values: readonly StickAnimationValues[]): void {
  for (const stick of values) {
    stick.rotation.stopAnimation();
    stick.scaleX.stopAnimation();
    stick.scaleY.stopAnimation();
    stick.translateX.stopAnimation();
    stick.translateY.stopAnimation();
    stick.rotation.setValue(0);
    stick.scaleX.setValue(1);
    stick.scaleY.setValue(1);
    stick.translateX.setValue(0);
    stick.translateY.setValue(0);
  }
}

export function Logo({ accessibilityLabel = "Chalk", color = DEFAULT_COLOR, height = DEFAULT_HEIGHT, motion = DEFAULT_MOTION, variant = DEFAULT_VARIANT }: LogoProps): React.JSX.Element {
  const [reducedMotion, setReducedMotion] = useState<boolean | null>(null);
  const [interaction, setInteraction] = useState<InteractionState>({ focus: false, hover: false, press: false });
  const idPrefix = `chalk-logo-${useId().replace(/[^a-zA-Z0-9_-]/gu, "")}`;
  const animationValues = useRef<StickAnimationValuesTuple | null>(null);
  if (animationValues.current === null) {
    animationValues.current = createStickAnimationValues();
  }

  const sticks = animationValues.current;
  const interactionActive = interaction.focus || interaction.hover || interaction.press;
  const animate = motion === "orbit-burst" && reducedMotion === false;

  useEffect(() => {
    let cancelled = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReducedMotion);

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (!cancelled) {
        setReducedMotion(enabled);
      }
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!animate) {
      resetStickAnimationValues(sticks);
      return;
    }

    const animations = interactionActive
      ? [createBurstAnimation(sticks[0], STICK_MOTIONS[0]), createBurstAnimation(sticks[1], STICK_MOTIONS[1]), createBurstAnimation(sticks[2], STICK_MOTIONS[2]), createBurstAnimation(sticks[3], STICK_MOTIONS[3])]
      : [createOrbitAnimation(sticks[0], STICK_MOTIONS[0], 0), createOrbitAnimation(sticks[1], STICK_MOTIONS[1], 1), createOrbitAnimation(sticks[2], STICK_MOTIONS[2], 2), createOrbitAnimation(sticks[3], STICK_MOTIONS[3], 3)];
    const animation = Animated.parallel(animations);
    animation.start();

    return () => {
      animation.stop();
    };
  }, [animate, interactionActive, sticks]);

  const setInteractionFlag = (key: keyof InteractionState, value: boolean): void => {
    setInteraction((current) => (current[key] === value ? current : { ...current, [key]: value }));
  };
  const width = variant === "wordmark" ? height * 2.5 : height * (68 / 80);
  const viewBox = variant === "wordmark" ? WORDMARK_VIEW_BOX : MARK_VIEW_BOX;
  const accessible = accessibilityLabel !== null;

  return (
    <Pressable
      accessible={false}
      onBlur={() => setInteractionFlag("focus", false)}
      onFocus={() => setInteractionFlag("focus", true)}
      onHoverIn={() => setInteractionFlag("hover", true)}
      onHoverOut={() => setInteractionFlag("hover", false)}
      onPressIn={() => setInteractionFlag("press", true)}
      onPressOut={() => setInteractionFlag("press", false)}
    >
      <Svg accessibilityLabel={accessible ? (accessibilityLabel ?? undefined) : undefined} accessible={accessible} color={color} fill="none" focusable={false} height={height} viewBox={viewBox} width={width}>
        <Defs>
          <LinearGradient id={`${idPrefix}-green`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#C5E5C0" />
            <Stop offset="100%" stopColor="#80B879" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-yellow`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#FCEAB3" />
            <Stop offset="100%" stopColor="#D9B641" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-blue`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#B2E0F0" />
            <Stop offset="100%" stopColor="#55AAC9" />
          </LinearGradient>
          <LinearGradient id={`${idPrefix}-pink`} x1="0%" x2="100%" y1="0%" y2="0%">
            <Stop offset="0%" stopColor="#F8CACA" />
            <Stop offset="100%" stopColor="#D67B7B" />
          </LinearGradient>
        </Defs>

        <G transform="translate(2, 2) scale(0.95)">
          <AnimatedG originX={STICK_MOTIONS[0].originX} originY={STICK_MOTIONS[0].originY} rotation={sticks[0].rotation} scaleX={sticks[0].scaleX} scaleY={sticks[0].scaleY} transform={STICK_MOTIONS[0].transform} translateX={sticks[0].translateX} translateY={sticks[0].translateY}>
            <Path d="M9,20 L21,20 L22,63 A7,7 0 0 1 8,63 Z" fill={`url(#${idPrefix}-green)`} />
            <Ellipse cx="15" cy="20" fill="#D8ECD4" rx="6" ry="2.5" />
          </AnimatedG>

          <AnimatedG originX={STICK_MOTIONS[1].originX} originY={STICK_MOTIONS[1].originY} rotation={sticks[1].rotation} scaleX={sticks[1].scaleX} scaleY={sticks[1].scaleY} transform={STICK_MOTIONS[1].transform} translateX={sticks[1].translateX} translateY={sticks[1].translateY}>
            <Path d="M23,15 L35,15 L36,60 A7,7 0 0 1 22,60 Z" fill={`url(#${idPrefix}-yellow)`} />
            <Ellipse cx="29" cy="15" fill="#FEF3D1" rx="6" ry="2.5" />
          </AnimatedG>

          <AnimatedG originX={STICK_MOTIONS[2].originX} originY={STICK_MOTIONS[2].originY} rotation={sticks[2].rotation} scaleX={sticks[2].scaleX} scaleY={sticks[2].scaleY} transform={STICK_MOTIONS[2].transform} translateX={sticks[2].translateX} translateY={sticks[2].translateY}>
            <Path d="M36,8 L48,8 L49,56 A7,7 0 0 1 35,56 Z" fill={`url(#${idPrefix}-blue)`} />
            <Ellipse cx="42" cy="8" fill="#D0EDF8" rx="6" ry="2.5" />
          </AnimatedG>

          <AnimatedG originX={STICK_MOTIONS[3].originX} originY={STICK_MOTIONS[3].originY} rotation={sticks[3].rotation} scaleX={sticks[3].scaleX} scaleY={sticks[3].scaleY} transform={STICK_MOTIONS[3].transform} translateX={sticks[3].translateX} translateY={sticks[3].translateY}>
            <Path d="M49,70 L61,70 L62,29 A7,7 0 0 0 48,29 Z" fill={`url(#${idPrefix}-pink)`} />
            <Ellipse cx="55" cy="70" fill="#FBE4E4" rx="6" ry="2.5" />
          </AnimatedG>
        </G>

        {variant === "wordmark" ? (
          <SvgText fill="currentColor" fontFamily="system-ui, -apple-system, BlinkMacSystemFont, sans-serif" fontSize="38" fontWeight="600" letterSpacing="-0.02em" x="90" y="52">
            chalk
          </SvgText>
        ) : null}
      </Svg>
    </Pressable>
  );
}
