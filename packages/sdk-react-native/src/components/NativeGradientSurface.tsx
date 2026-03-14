import { memo, useMemo } from "react";
import { StyleSheet } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { getParticipantColor, type ParticipantGradientPreference } from "@q9labs/chalk-core";

export interface NativeGradientSurfaceProps {
  participantId?: string;
  gradientPreference?: ParticipantGradientPreference;
  borderRadius?: number;
  angle?: "vertical" | "diagonal";
  opacity?: number;
}

function NativeGradientSurfaceBase({
  participantId,
  gradientPreference,
  borderRadius = 0,
  angle = "vertical",
  opacity = 1,
}: NativeGradientSurfaceProps): React.JSX.Element {
  const colors = useMemo(() => getParticipantColor(participantId, gradientPreference), [gradientPreference, participantId]);
  const gradientId = useMemo(() => `gradient-${Math.random().toString(36).slice(2, 10)}`, []);

  return (
    <Svg height="100%" pointerEvents="none" style={[StyleSheet.absoluteFillObject, { opacity }]} width="100%">
      <Defs>
        <LinearGradient
          id={gradientId}
          x1="0%"
          x2={angle === "diagonal" ? "100%" : "0%"}
          y1="0%"
          y2="100%"
        >
          <Stop offset="0%" stopColor={colors.primary} />
          <Stop offset="100%" stopColor={colors.gradientEnd} />
        </LinearGradient>
      </Defs>
      <Rect fill={`url(#${gradientId})`} height="100%" rx={borderRadius} ry={borderRadius} width="100%" />
    </Svg>
  );
}

export const NativeGradientSurface = memo(NativeGradientSurfaceBase);
