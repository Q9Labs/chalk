import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_PANEL_CLASSES, type ChalkTone } from "./common";

export interface ChalkTooltipPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
}

export const ChalkTooltipPanel = forwardRef<HTMLDivElement, ChalkTooltipPanelProps>(function ChalkTooltipPanel({ children, className, style, tone = "neutral", role = "tooltip", ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, "max-w-xs rounded-md px-3 py-2 text-xs text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-xs,var(--chalk-shadow))]"), className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkTooltipPanel.displayName = "ChalkTooltipPanel";
