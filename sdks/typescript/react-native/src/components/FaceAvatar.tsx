import { getParticipantAvatarRecipe, getParticipantInitials } from "../ui/participant-avatar";
import type { ParticipantGradientPreference } from "../ui/native-types";
import { memo, useEffect, useMemo, useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import { Theme } from "../ui/theme";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
export type AvatarStatus = "online" | "away" | "busy" | "offline";

const sizeMap: Record<AvatarSize, { size: number }> = {
  xs: { size: 24 },
  sm: { size: 32 },
  md: { size: 48 },
  lg: { size: 64 },
  xl: { size: 96 },
  "2xl": { size: 120 },
};

const statusColorMap: Record<AvatarStatus, string> = {
  online: Theme.colors.success,
  away: Theme.colors.warning,
  busy: Theme.colors.error,
  offline: Theme.colors.ink3,
};

export interface FaceAvatarProps {
  name?: string;
  src?: string;
  size?: AvatarSize | number;
  status?: AvatarStatus;
  gradientPreference?: ParticipantGradientPreference;
  audioLevel?: number;
  textSize?: number;
}

function FaceAvatarBase({ name, src, size = "md", status, gradientPreference, audioLevel = 0, textSize }: FaceAvatarProps): React.JSX.Element {
  const [imageError, setImageError] = useState(false);
  const hasUploadedImage = Boolean(src) && !imageError;

  useEffect(() => {
    setImageError(false);
  }, [name, src]);

  const { pxSize } = useMemo(() => {
    if (typeof size === "number") {
      return { pxSize: size };
    }
    const mapped = sizeMap[size];
    return { pxSize: mapped.size };
  }, [size]);

  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(name || "unknown", gradientPreference), [gradientPreference, name]);
  const initials = useMemo(() => getParticipantInitials(name), [name]);

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
          <Image source={{ uri: src }} style={avatarStyle} onError={() => setImageError(true)} />
        ) : (
          <View style={[StyleSheet.absoluteFillObject, styles.initialsAvatar, { backgroundColor: avatarRecipe.colors.primary }]}>
            <Text allowFontScaling={false} style={[styles.initials, { fontSize: textSize ?? Math.max(12, Math.round(pxSize * 0.34)) }]} testID="avatar-initials">
              {initials}
            </Text>
          </View>
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
              borderColor: Theme.colors.surface,
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
  initialsAvatar: {
    alignItems: "center",
    justifyContent: "center",
  },
  initials: {
    color: Theme.colors.surface,
    fontWeight: "600",
    includeFontPadding: false,
    textAlign: "center",
  },
  statusIndicator: {
    position: "absolute",
    bottom: 0,
    right: 0,
  },
});

export const FaceAvatar = memo(FaceAvatarBase);
