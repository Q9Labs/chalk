import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_PANEL_CLASSES, type ChalkTone } from "./common";

export interface ChalkDialogPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
}

export const ChalkDialogPanel = forwardRef<HTMLDivElement, ChalkDialogPanelProps>(function ChalkDialogPanel({ children, className, role = "dialog", style, tone = "neutral", ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, "rounded-xl p-5 text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]"), className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkDialogPanel.displayName = "ChalkDialogPanel";
