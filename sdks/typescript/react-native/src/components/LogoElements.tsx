import { useRef } from "react";
import { Animated } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { Theme } from "../ui/theme";
import { createAnimationRefController, type AnimationRefCallback } from "./native-animation-controller";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

interface LogoElementsProps {
  size?: number;
}

export function LogoElements({ size = 64 }: LogoElementsProps): React.JSX.Element {
  const particle1 = useRef(new Animated.Value(0)).current;
  const particle2 = useRef(new Animated.Value(0)).current;
  const particle3 = useRef(new Animated.Value(0)).current;
  const arcProgress = useRef(new Animated.Value(0)).current;

  const animationRef = useRef<AnimationRefCallback<unknown> | null>(null);
  const attachAnimations =
    animationRef.current ??
    (animationRef.current = createAnimationRefController<unknown>(() => {
      const createParticleAnimation = (animation: Animated.Value, delay: number) =>
        Animated.loop(
          Animated.sequence([
            Animated.delay(delay),
            Animated.timing(animation, {
              toValue: 1,
              duration: 2500,
              useNativeDriver: true,
            }),
          ]),
        );

      const particleAnimations = [createParticleAnimation(particle1, 0), createParticleAnimation(particle2, 800), createParticleAnimation(particle3, 1600)];
      const arcAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(arcProgress, {
            toValue: 1,
            duration: 3500,
            useNativeDriver: true,
          }),
          Animated.delay(2500),
        ]),
      );

      return [...particleAnimations, arcAnimation];
    }));

  const createParticleProps = (animation: Animated.Value, xOffset: number) => ({
    opacity: animation.interpolate({
      inputRange: [0, 0.2, 0.8, 1],
      outputRange: [0, 0.5, 0.5, 0],
    }),
    transform: [
      {
        translateY: animation.interpolate({
          inputRange: [0, 1],
          outputRange: [0, -20],
        }),
      },
      {
        translateX: animation.interpolate({
          inputRange: [0, 1],
          outputRange: [0, xOffset],
        }),
      },
    ],
  });

  return (
    <Svg ref={attachAnimations} width={size} height={size} viewBox="0 0 64 64" fill="none">
      <AnimatedPath
        d="M 12 16 Q 32 -2 52 16"
        stroke={Theme.logo.arc}
        strokeWidth="1.5"
        strokeLinecap="round"
        fill="none"
        opacity={arcProgress.interpolate({
          inputRange: [0, 0.2, 0.7, 1],
          outputRange: [0, 1, 1, 0],
        })}
        transform={[
          {
            translateY: arcProgress.interpolate({
              inputRange: [0, 1],
              outputRange: [4, -4],
            }),
          },
        ]}
      />

      <AnimatedCircle cx="16" cy="12" r="1.5" fill={Theme.logo.mint} {...createParticleProps(particle1, -8)} />
      <AnimatedCircle cx="28" cy="8" r="2" fill={Theme.logo.gold} {...createParticleProps(particle2, 4)} />
      <AnimatedCircle cx="40" cy="6" r="1.5" fill={Theme.logo.sky} {...createParticleProps(particle3, 8)} />

      <G transform="rotate(-20 16 48)">
        <Rect x="8" y="16" width="12" height="40" rx="6" fill={Theme.logo.mint} />
        <Ellipse cx="14" cy="16" rx="6" ry="3.5" fill={Theme.logo.mintDark} />
      </G>

      <G transform="rotate(-5 24 44)">
        <Rect x="18" y="12" width="12" height="44" rx="6" fill={Theme.logo.gold} />
        <Ellipse cx="24" cy="12" rx="6" ry="3.5" fill={Theme.logo.goldDark} />
      </G>

      <G transform="rotate(25 44 20)">
        <Rect x="28" y="4" width="12" height="42" rx="6" fill={Theme.logo.sky} />
        <Ellipse cx="34" cy="4" rx="6" ry="3.5" fill={Theme.logo.skyDark} />
      </G>

      <G transform="rotate(10 44 40)">
        <Rect x="38" y="18" width="12" height="38" rx="6" fill={Theme.logo.coral} />
        <Ellipse cx="44" cy="56" rx="6" ry="3.5" fill={Theme.logo.coralDark} />
      </G>
    </Svg>
  );
}
