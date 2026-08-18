import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkBackdropProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkBackdrop = forwardRef<HTMLDivElement, ChalkBackdropProps>(function ChalkBackdrop({ className, seed, roughness, style, tone = "neutral", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div ref={ref} aria-hidden="true" className={cn(skin === "classic" ? "pointer-events-auto fixed inset-0 bg-[var(--chalk-app-canvas,var(--chalk-canvas))]/75" : "pointer-events-auto fixed inset-0 bg-transparent", className)} style={{ position: "fixed", ...style }} {...props}>
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled focusStroke={stroke} radius={0} roughness={roughness} seed={seed} stroke={stroke} />
    </div>
  );
});

ChalkBackdrop.displayName = "ChalkBackdrop";
