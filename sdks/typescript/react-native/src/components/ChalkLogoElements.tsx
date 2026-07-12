import { useRef } from "react";
import { Animated } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";
import { createAnimationRefController, type AnimationRefCallback } from "./native-animation-controller";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

interface ChalkLogoElementsProps {
  size?: number;
}

export function ChalkLogoElements({ size = 64 }: ChalkLogoElementsProps): React.JSX.Element {
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
        stroke="#7EC8E3"
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

      <AnimatedCircle cx="16" cy="12" r="1.5" fill="#A8D5A2" {...createParticleProps(particle1, -8)} />
      <AnimatedCircle cx="28" cy="8" r="2" fill="#F5D76E" {...createParticleProps(particle2, 4)} />
      <AnimatedCircle cx="40" cy="6" r="1.5" fill="#7EC8E3" {...createParticleProps(particle3, 8)} />

      <G transform="rotate(-20 16 48)">
        <Rect x="8" y="16" width="12" height="40" rx="6" fill="#A8D5A2" />
        <Ellipse cx="14" cy="16" rx="6" ry="3.5" fill="#8BC585" />
      </G>

      <G transform="rotate(-5 24 44)">
        <Rect x="18" y="12" width="12" height="44" rx="6" fill="#F5D76E" />
        <Ellipse cx="24" cy="12" rx="6" ry="3.5" fill="#E8C85A" />
      </G>

      <G transform="rotate(25 44 20)">
        <Rect x="28" y="4" width="12" height="42" rx="6" fill="#7EC8E3" />
        <Ellipse cx="34" cy="4" rx="6" ry="3.5" fill="#5FB8D9" />
      </G>

      <G transform="rotate(10 44 40)">
        <Rect x="38" y="18" width="12" height="38" rx="6" fill="#F0A0A0" />
        <Ellipse cx="44" cy="56" rx="6" ry="3.5" fill="#E88888" />
      </G>
    </Svg>
  );
}
