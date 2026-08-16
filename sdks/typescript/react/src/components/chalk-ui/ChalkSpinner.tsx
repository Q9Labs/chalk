import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkSpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: string;
}

export const ChalkSpinner = forwardRef<HTMLSpanElement, ChalkSpinnerProps>(function ChalkSpinner({ className, label = "Loading", seed, roughness, style, tone = "accent", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <span ref={ref} aria-label={label} className={cn("motion-safe:animate-spin relative inline-block size-6", className)} role="status" style={style} {...props}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} shape="circle" roughness={roughness} seed={seed} stroke={stroke} />
    </span>
  );
});

ChalkSpinner.displayName = "ChalkSpinner";
