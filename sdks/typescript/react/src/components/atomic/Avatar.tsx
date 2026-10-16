import React from "react";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ClassicAvatar } from "./ClassicAvatar";

export interface AvatarProps {
  name: string;
  src?: string;
  size?: "xs" | "sm" | "md" | "lg" | "xl" | "2xl";
  status?: "online" | "away" | "busy" | "offline";
  className?: string;
  style?: React.CSSProperties;
  gradientPreference?: ParticipantGradientPreference;
  generated?: boolean;
  /** Disable autonomous avatar motion for deterministic presentation captures. */
  animated?: boolean;
  /** Stable identity for deterministic Chalk chrome across projection seeks. */
  seed?: number | string;
}

export const Avatar = React.memo((props: AvatarProps) => {
  return <ClassicAvatar {...props} />;
});

Avatar.displayName = "Avatar";
