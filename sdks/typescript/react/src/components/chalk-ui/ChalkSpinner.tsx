import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkSpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: string;
}

export const ChalkSpinner = forwardRef<HTMLSpanElement, ChalkSpinnerProps>(function ChalkSpinner({ className, label = "Loading", seed, roughness, style, tone = "accent", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <span
      ref={ref}
      aria-label={label}
      className={cn(skin === "classic" ? "motion-safe:animate-spin inline-block size-6 rounded-full border-2 border-[var(--chalk-app-line,var(--chalk-line))] border-t-[var(--chalk-app-control-active-line,var(--chalk-accent))]" : "motion-safe:animate-spin relative inline-block size-6", className)}
      role="status"
      style={style}
      {...props}
    >
      {skin === "chalk" ? <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} shape="circle" roughness={roughness} seed={seed} stroke={stroke} /> : null}
    </span>
  );
});

ChalkSpinner.displayName = "ChalkSpinner";
