import React from "react";
import { ClassicTourTooltip } from "./ClassicTourTooltip";

export interface TourTooltipProps {
  title: string;
  description: string;
  step: number;
  totalSteps: number;
  placement?: "top" | "bottom" | "left" | "right";
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  showSkip?: boolean;
  showProgress?: boolean;
  className?: string;
}

export const TourTooltip = React.memo<TourTooltipProps>((props) => {
  return <ClassicTourTooltip {...props} />;
});

TourTooltip.displayName = "TourTooltip";
