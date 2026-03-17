import { getParticipantAvatarRecipe, type ParticipantGradientPreference } from "@q9labs/chalk-core";
import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { NativeGradientSurface } from "./NativeGradientSurface";

export interface NativeFaceAvatarProps {
  name?: string;
  size?: number;
  gradientPreference?: ParticipantGradientPreference;
  audioLevel?: number;
  textSize?: number;
}

function NativeFaceAvatarBase({ name, size = 120, gradientPreference, audioLevel = 0, textSize }: NativeFaceAvatarProps): React.JSX.Element {
  const blinkScale = useRef(new Animated.Value(1)).current;
  const glowScale = useRef(new Animated.Value(1)).current;
  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(name, gradientPreference), [gradientPreference, name]);
  const resolvedTextSize = textSize ?? Math.round(size * 0.34);

  useEffect(() => {
    const blinkLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(2400),
        Animated.timing(blinkScale, {
          duration: 80,
          easing: Easing.out(Easing.quad),
          toValue: 0.08,
          useNativeDriver: true,
        }),
        Animated.timing(blinkScale, {
          duration: 110,
          easing: Easing.out(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
        Animated.delay(120),
        Animated.timing(blinkScale, {
          duration: 65,
          easing: Easing.out(Easing.quad),
          toValue: 0.15,
          useNativeDriver: true,
        }),
        Animated.timing(blinkScale, {
          duration: 110,
          easing: Easing.out(Easing.quad),
          toValue: 1,
          useNativeDriver: true,
        }),
      ]),
    );

    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glowScale, {
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          toValue: 1.08,
          useNativeDriver: true,
        }),
        Animated.timing(glowScale, {
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          toValue: 0.96,
          useNativeDriver: true,
        }),
      ]),
    );

    blinkLoop.start();
    glowLoop.start();

    return () => {
      blinkLoop.stop();
      glowLoop.stop();
    };
  }, [blinkScale, glowScale]);

  const pulseScale = 1 + Math.min(0.12, Math.max(0, audioLevel) * 0.08);

  return (
    <Animated.View style={[styles.wrapper, { height: size, transform: [{ scale: pulseScale }], width: size }]}>
      <Animated.View
        style={[
          styles.glow,
          {
            backgroundColor: avatarRecipe.colors.primary,
            borderRadius: size / 2,
            height: size * 0.72,
            opacity: 0.18,
            transform: [{ scale: glowScale }],
            width: size * 0.72,
          },
        ]}
      />
      <View style={[styles.avatar, { borderRadius: size / 2, height: size, width: size }]}>
        <NativeGradientSurface angle="diagonal" borderRadius={size / 2} gradientPreference={gradientPreference} participantId={name} variant="avatar" />
        <View style={styles.face}>
          <View style={[styles.eyesRow, { gap: size * 0.18 }]}>
            <Animated.View style={[styles.eye, { borderRadius: size * 0.05, height: size * 0.1, transform: [{ scaleY: blinkScale }], width: size * 0.1 }]} />
            <Animated.View style={[styles.eye, { borderRadius: size * 0.05, height: size * 0.1, transform: [{ scaleY: blinkScale }], width: size * 0.1 }]} />
          </View>
          <Text style={[styles.initial, { fontSize: resolvedTextSize }]}>{avatarRecipe.initials}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  glow: {
    position: "absolute",
  },
  avatar: {
    overflow: "hidden",
  },
  face: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  eyesRow: {
    flexDirection: "row",
    marginBottom: 6,
  },
  eye: {
    backgroundColor: "#ffffff",
  },
  initial: {
    color: "#ffffff",
    fontWeight: "400",
  },
});

export const NativeFaceAvatar = memo(NativeFaceAvatarBase);
