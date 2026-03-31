import { getParticipantAvatarRecipe, type ParticipantGradientPreference } from "@q9labs/chalk-core";
import { memo, useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { NativeGradientSurface } from "./NativeGradientSurface";

export interface NativeFaceAvatarProps {
  name?: string;
  size?: number;
  gradientPreference?: ParticipantGradientPreference;
  audioLevel?: number;
  textSize?: number;
}

function NativeFaceAvatarBase({ name, size = 120, gradientPreference, audioLevel = 0, textSize }: NativeFaceAvatarProps): React.JSX.Element {
  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(name, gradientPreference), [gradientPreference, name]);
  const resolvedTextSize = textSize ?? Math.round(size * 0.34);

  const wrapperStyle = useMemo(
    () => ({
      height: size,
      width: size,
      transform: [{ scale: 1 + Math.min(0.06, Math.max(0, audioLevel) * 0.04) }],
    }),
    [size, audioLevel],
  );

  const avatarStyle = useMemo(
    () => ({
      borderRadius: size / 2,
      height: size,
      width: size,
    }),
    [size],
  );

  return (
    <View style={[styles.wrapper, wrapperStyle]}>
      <View style={[styles.avatar, avatarStyle]}>
        <NativeGradientSurface angle="diagonal" borderRadius={size / 2} gradientPreference={gradientPreference} participantId={name} variant="avatar" />
        <View style={styles.initialsContainer}>
          <Text style={[styles.initial, { fontSize: resolvedTextSize }]}>{avatarRecipe.initials}</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    overflow: "hidden",
  },
  initialsContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  initial: {
    color: "#ffffff",
    fontWeight: "700",
  },
});

export const NativeFaceAvatar = memo(NativeFaceAvatarBase);
