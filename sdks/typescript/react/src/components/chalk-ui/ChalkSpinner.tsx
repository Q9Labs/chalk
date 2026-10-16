import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { type ChalkTone } from "./common";

export interface ChalkSpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ChalkTone;

  readonly label?: string;
}

export const ChalkSpinner = forwardRef<HTMLSpanElement, ChalkSpinnerProps>(function ChalkSpinner({ className, label = "Loading", style, tone = "accent", ...props }, ref) {
  return (
    <span ref={ref} aria-label={label} className={cn("motion-safe:animate-spin inline-block size-6 rounded-full border-2 border-[var(--chalk-app-line,var(--chalk-line))] border-t-[var(--chalk-app-control-active-line,var(--chalk-accent))]", className)} role="status" style={style} {...props}></span>
  );
});

ChalkSpinner.displayName = "ChalkSpinner";
