import React from "react";
import { ClassicConnectionQuality } from "./ClassicConnectionQuality";

export interface ConnectionQualityProps {
  quality: 1 | 2 | 3 | 4;
  showLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}

export const ConnectionQuality = React.memo((props: ConnectionQualityProps) => {
  return <ClassicConnectionQuality {...props} />;
});

ConnectionQuality.displayName = "ConnectionQuality";
