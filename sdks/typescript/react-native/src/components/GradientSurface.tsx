import { memo, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { getParticipantColor } from "../ui/participant-avatar";
import type { ParticipantGradientPreference } from "../ui/native-types";

export interface GradientSurfaceProps {
  participantId?: string;
  gradientPreference?: ParticipantGradientPreference;
  borderRadius?: number;
  /** @deprecated Kept for API compatibility; identity surfaces are now flat. */
  angle?: "vertical" | "diagonal";
  opacity?: number;
  variant?: "surface" | "avatar";
}

function GradientSurfaceBase({ participantId, gradientPreference, borderRadius = 0, opacity = 1, variant = "surface" }: GradientSurfaceProps): React.JSX.Element {
  const colors = useMemo(() => getParticipantColor(participantId, gradientPreference), [gradientPreference, participantId]);
  const backgroundColor = variant === "avatar" ? colors.primary : colors.surface;

  return <View pointerEvents="none" style={[StyleSheet.absoluteFillObject, { backgroundColor, borderRadius, opacity }]} />;
}

export const GradientSurface = memo(GradientSurfaceBase);
