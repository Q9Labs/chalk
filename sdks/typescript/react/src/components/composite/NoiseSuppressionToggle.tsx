import React from "react";
import { ClassicNoiseSuppressionToggle } from "./ClassicNoiseSuppressionToggle";

export interface NoiseSuppressionToggleProps {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  level?: "low" | "medium" | "high";
  onLevelChange?: (level: "low" | "medium" | "high") => void;
  disabled?: boolean;
  className?: string;
}

export const NoiseSuppressionToggle = React.memo((props: NoiseSuppressionToggleProps): React.JSX.Element => {
  return <ClassicNoiseSuppressionToggle {...props} />;
});

NoiseSuppressionToggle.displayName = "NoiseSuppressionToggle";
