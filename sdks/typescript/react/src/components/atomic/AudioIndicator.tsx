import React from "react";
import { ClassicAudioIndicator } from "./ClassicAudioIndicator";

interface AudioIndicatorProps {
  level?: number;
  muted?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "bars" | "icon" | "dot";
  className?: string;
}

export const AudioIndicator = React.memo((props: AudioIndicatorProps) => {
  return <ClassicAudioIndicator {...props} />;
});

AudioIndicator.displayName = "AudioIndicator";
