import { memo, useMemo } from "react";
import { StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { getParticipantAvatarRecipe, getParticipantColor, type ParticipantGradientPreference } from "@q9labs/chalk-core";

export interface NativeGradientSurfaceProps {
  participantId?: string;
  gradientPreference?: ParticipantGradientPreference;
  borderRadius?: number;
  angle?: "vertical" | "diagonal";
  opacity?: number;
  variant?: "surface" | "avatar";
}

function NativeGradientSurfaceBase({ participantId, gradientPreference, borderRadius = 0, angle = "vertical", opacity = 1, variant = "surface" }: NativeGradientSurfaceProps): React.JSX.Element {
  const colors = useMemo(() => getParticipantColor(participantId, gradientPreference), [gradientPreference, participantId]);
  const avatarRecipe = useMemo(() => getParticipantAvatarRecipe(participantId, gradientPreference), [gradientPreference, participantId]);
  const gradientId = useMemo(() => `gradient-${Math.random().toString(36).slice(2, 10)}`, []);
  const stops =
    variant === "avatar"
      ? avatarRecipe.gradientStops
      : [
          { color: colors.primary, offset: "0%" },
          { color: colors.gradientEnd, offset: "100%" },
        ];

  return (
    <Svg height="100%" pointerEvents="none" style={[StyleSheet.absoluteFillObject, { opacity }]} width="100%">
      <Defs>
        <LinearGradient id={gradientId} x1="0%" x2={angle === "diagonal" ? "100%" : "0%"} y1="0%" y2="100%">
          {stops.map((stop, index) => (
            <Stop key={`${stop.offset}-${stop.color}-${index}`} offset={stop.offset} stopColor={stop.color} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect fill={`url(#${gradientId})`} height="100%" rx={borderRadius} ry={borderRadius} width="100%" />
    </Svg>
  );
}

export const NativeGradientSurface = memo(NativeGradientSurfaceBase);
