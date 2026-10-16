import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_CLASSES, CLASSIC_PANEL_CLASSES, mergeStyle, type ChalkTone } from "./common";

export interface ChalkPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;

  readonly contentClassName?: string;
}

export const ChalkPanel = forwardRef<HTMLDivElement, ChalkPanelProps>(function ChalkPanel({ children, className, contentClassName, tone = "neutral", style, ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, CLASSIC_FOCUS_CLASSES, "relative rounded-xl p-4 text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]"), className)} style={mergeStyle(style)} {...props}>
      <div className={cn("relative z-[1]", contentClassName)}>{children}</div>
    </div>
  );
});

ChalkPanel.displayName = "ChalkPanel";
