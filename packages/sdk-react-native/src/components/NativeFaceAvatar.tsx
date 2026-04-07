import { getParticipantAvatarRecipe, type ParticipantGradientPreference } from "@q9labs/chalk-core";
import { memo, useMemo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { NativeGradientSurface } from "./NativeGradientSurface";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
export type AvatarStatus = "online" | "away" | "busy" | "offline";

const sizeMap: Record<AvatarSize, { size: number; fontSize: number }> = {
  xs: { size: 24, fontSize: 10 },
  sm: { size: 32, fontSize: 12 },
  md: { size: 48, fontSize: 16 },
  lg: { size: 64, fontSize: 24 },
  xl: { size: 96, fontSize: 36 },
  "2xl": { size: 120, fontSize: 44 },
};

const statusColorMap: Record<AvatarStatus, string> = {
  online: "#22c55e",
  away: "#f59e0b",
  busy: "#ef4444",
  offline: "#6b7280",
};

export interface NativeFaceAvatarProps {
  name?: string;
  src?: string;
  size?: AvatarSize | number;
  status?: AvatarStatus;
  gradientPreference?: ParticipantGradientPreference;
  audioLevel?: number;
  textSize?: number;
}

function NativeFaceAvatarBase({
  name,
  src,
  size = "md",
  status,
  gradientPreference,
  audioLevel = 0,
  textSize,
}: NativeFaceAvatarProps): React.JSX.Element {
  const [imageError, setImageError] = useState(false);
  const hasUploadedImage = Boolean(src) && !imageError;

  const { pxSize, fontSize } = useMemo(() => {
    if (typeof size === "number") {
      return { pxSize: size, fontSize: textSize ?? Math.round(size * 0.34) };
    }
    const mapped = sizeMap[size];
    return { pxSize: mapped.size, fontSize: textSize ?? mapped.fontSize };
  }, [size, textSize]);

  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(name || "unknown", gradientPreference), [gradientPreference, name]);

  const wrapperStyle = useMemo(
    () => ({
      height: pxSize,
      width: pxSize,
      transform: [{ scale: 1 + Math.min(0.06, Math.max(0, audioLevel) * 0.04) }],
    }),
    [pxSize, audioLevel],
  );

  const avatarStyle = useMemo(
    () => ({
      borderRadius: pxSize / 2,
      height: pxSize,
      width: pxSize,
    }),
    [pxSize],
  );

  const statusSize = Math.max(8, pxSize / 4);

  return (
    <View style={[styles.wrapper, wrapperStyle]}>
      <View style={[styles.avatar, avatarStyle]}>
        {hasUploadedImage ? (
          <Image
            source={{ uri: src }}
            style={{ width: pxSize, height: pxSize, borderRadius: pxSize / 2 }}
            onError={() => setImageError(true)}
          />
        ) : (
          <>
            <NativeGradientSurface angle="diagonal" borderRadius={pxSize / 2} gradientPreference={gradientPreference} participantId={name} variant="avatar" />
            <View style={styles.initialsContainer}>
              <Text style={[styles.initial, { fontSize, color: "#ffffff" }]}>{avatarRecipe.initials}</Text>
            </View>
          </>
        )}
      </View>
      {status && (
        <View
          style={[
            styles.statusIndicator,
            {
              width: statusSize,
              height: statusSize,
              borderRadius: statusSize / 2,
              backgroundColor: statusColorMap[status],
              borderWidth: 2,
              borderColor: "#000000",
            },
          ]}
        />
      )}
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
  statusIndicator: {
    position: "absolute",
    bottom: 0,
    right: 0,
  },
});

export const NativeFaceAvatar = memo(NativeFaceAvatarBase);
