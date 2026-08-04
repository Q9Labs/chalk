import { useEffect, useRef } from "react";
import { Animated } from "react-native";
import Svg, { Circle, Ellipse, G, Path, Rect } from "react-native-svg";

const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedPath = Animated.createAnimatedComponent(Path);

type BrandMarkProps = {
  readonly size?: number;
};

export function BrandMark({ size = 64 }: BrandMarkProps): React.JSX.Element {
  const particle1 = useRef(new Animated.Value(0)).current;
  const particle2 = useRef(new Animated.Value(0)).current;
  const particle3 = useRef(new Animated.Value(0)).current;
  const arcProgress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const createParticleAnimation = (animation: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(animation, {
            toValue: 1,
            duration: 2_500,
            useNativeDriver: true,
          }),
        ]),
      );
    const arcAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(arcProgress, {
          toValue: 1,
          duration: 3_500,
          useNativeDriver: true,
        }),
        Animated.delay(2_500),
      ]),
    );
    const animations = [createParticleAnimation(particle1, 0), createParticleAnimation(particle2, 800), createParticleAnimation(particle3, 1_600), arcAnimation];

    animations.forEach((animation) => animation.start());
    return () => animations.forEach((animation) => animation.stop());
  }, [arcProgress, particle1, particle2, particle3]);

  const particleProps = (animation: Animated.Value, xOffset: number) => ({
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
    <Svg fill="none" height={size} viewBox="0 0 64 64" width={size}>
      <AnimatedPath
        d="M 12 16 Q 32 -2 52 16"
        fill="none"
        opacity={arcProgress.interpolate({
          inputRange: [0, 0.2, 0.7, 1],
          outputRange: [0, 1, 1, 0],
        })}
        stroke="#7EC8E3"
        strokeLinecap="round"
        strokeWidth="1.5"
        transform={[
          {
            translateY: arcProgress.interpolate({
              inputRange: [0, 1],
              outputRange: [4, -4],
            }),
          },
        ]}
      />
      <AnimatedCircle cx="16" cy="12" fill="#A8D5A2" r="1.5" {...particleProps(particle1, -8)} />
      <AnimatedCircle cx="28" cy="8" fill="#F5D76E" r="2" {...particleProps(particle2, 4)} />
      <AnimatedCircle cx="40" cy="6" fill="#7EC8E3" r="1.5" {...particleProps(particle3, 8)} />
      <G transform="rotate(-20 16 48)">
        <Rect fill="#A8D5A2" height="40" rx="6" width="12" x="8" y="16" />
        <Ellipse cx="14" cy="16" fill="#8BC585" rx="6" ry="3.5" />
      </G>
      <G transform="rotate(-5 24 44)">
        <Rect fill="#F5D76E" height="44" rx="6" width="12" x="18" y="12" />
        <Ellipse cx="24" cy="12" fill="#E8C85A" rx="6" ry="3.5" />
      </G>
      <G transform="rotate(25 44 20)">
        <Rect fill="#7EC8E3" height="42" rx="6" width="12" x="28" y="4" />
        <Ellipse cx="34" cy="4" fill="#5FB8D9" rx="6" ry="3.5" />
      </G>
      <G transform="rotate(10 44 40)">
        <Rect fill="#F0A0A0" height="38" rx="6" width="12" x="38" y="18" />
        <Ellipse cx="44" cy="56" fill="#E88888" rx="6" ry="3.5" />
      </G>
    </Svg>
  );
}
