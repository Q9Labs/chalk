import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_PANEL_CLASSES, classicTonePanelClasses, type ChalkTone } from "./common";

export interface ChalkAlertProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
}

export const ChalkAlert = forwardRef<HTMLDivElement, ChalkAlertProps>(function ChalkAlert({ children, className, style, tone = "danger", role = "alert", ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, classicTonePanelClasses(tone), "rounded-lg px-4 py-3 text-sm shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]"), className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkAlert.displayName = "ChalkAlert";
