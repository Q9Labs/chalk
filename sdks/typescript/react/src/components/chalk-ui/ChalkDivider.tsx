import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkDividerProps extends HTMLAttributes<HTMLHRElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkDivider = forwardRef<HTMLHRElement, ChalkDividerProps>(function ChalkDivider({ className, tone = "neutral", seed, roughness, ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div className={cn("relative my-3 h-3 w-full", className)} data-chalk-tone={tone}>
      <hr ref={ref} className={cn(skin === "classic" ? "absolute inset-x-0 top-1/2 w-full -translate-y-1/2 border-0 border-t border-[var(--chalk-app-line,var(--chalk-line))]" : "absolute inset-0 h-full w-full border-0 opacity-0", className)} {...props} />
      {skin === "chalk" ? <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} height={12} shape="line" roughness={roughness} seed={seed} stroke={stroke} /> : null}
    </div>
  );
});

ChalkDivider.displayName = "ChalkDivider";
