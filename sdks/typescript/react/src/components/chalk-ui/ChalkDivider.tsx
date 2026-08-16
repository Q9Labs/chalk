import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkDividerProps extends HTMLAttributes<HTMLHRElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkDivider = forwardRef<HTMLHRElement, ChalkDividerProps>(function ChalkDivider({ className, tone = "neutral", seed, roughness, ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <div className={cn("relative my-3 h-3 w-full", className)} data-chalk-tone={tone}>
      <hr ref={ref} className={cn("absolute inset-0 h-full w-full border-0 opacity-0", className)} {...props} />
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} height={12} shape="line" roughness={roughness} seed={seed} stroke={stroke} />
    </div>
  );
});

ChalkDivider.displayName = "ChalkDivider";
