import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_PANEL_CLASSES, type ChalkTone } from "./common";

export interface ChalkEmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: ChalkTone;
}

export const ChalkEmptyState = forwardRef<HTMLDivElement, ChalkEmptyStateProps>(function ChalkEmptyState({ children, className, description, style, title, tone = "neutral", role = "status", ...props }, ref) {
  return (
    <div ref={ref} className={cn(cn(CLASSIC_PANEL_CLASSES, "rounded-xl px-6 py-10 text-center text-[var(--chalk-app-text,var(--chalk-text))]"), className)} role={role} style={{ position: "relative", ...style }} {...props}>
      <div className="relative z-[1]">
        {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
        {description ? <p className={cn("mt-2 text-sm", "text-[var(--chalk-app-text-muted,var(--chalk-muted-text))]")}>{description}</p> : null}
        {children}
      </div>
    </div>
  );
});

ChalkEmptyState.displayName = "ChalkEmptyState";
