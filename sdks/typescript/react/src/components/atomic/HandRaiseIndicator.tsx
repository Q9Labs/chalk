import React from "react";
import { ClassicHandRaiseIndicator } from "./ClassicHandRaiseIndicator";

interface HandRaiseIndicatorProps {
  raised: boolean;
  animated?: boolean;
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export const HandRaiseIndicator = React.memo((props: HandRaiseIndicatorProps) => {
  return <ClassicHandRaiseIndicator {...props} />;
});

HandRaiseIndicator.displayName = "HandRaiseIndicator";
