import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { type ChalkTone } from "./common";

export interface ChalkDividerProps extends HTMLAttributes<HTMLHRElement> {
  readonly tone?: ChalkTone;
}

export const ChalkDivider = forwardRef<HTMLHRElement, ChalkDividerProps>(function ChalkDivider({ className, tone = "neutral", ...props }, ref) {
  return (
    <div className={cn("relative my-3 h-3 w-full", className)} data-chalk-tone={tone}>
      <hr ref={ref} className={cn("absolute inset-x-0 top-1/2 w-full -translate-y-1/2 border-0 border-t border-[var(--chalk-app-line,var(--chalk-line))]", className)} {...props} />
    </div>
  );
});

ChalkDivider.displayName = "ChalkDivider";
