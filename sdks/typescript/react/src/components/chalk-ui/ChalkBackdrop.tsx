import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { type ChalkTone } from "./common";

export interface ChalkBackdropProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
}

export const ChalkBackdrop = forwardRef<HTMLDivElement, ChalkBackdropProps>(function ChalkBackdrop({ className, style, tone = "neutral", ...props }, ref) {
  return <div ref={ref} aria-hidden="true" className={cn("pointer-events-auto fixed inset-0 bg-[var(--chalk-app-canvas,var(--chalk-canvas))]/75", className)} style={{ position: "fixed", ...style }} {...props}></div>;
});

ChalkBackdrop.displayName = "ChalkBackdrop";
