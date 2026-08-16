import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { mergeStyle, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly filled?: boolean;
}

export const ChalkPanel = forwardRef<HTMLDivElement, ChalkPanelProps>(function ChalkPanel({ children, className, tone = "neutral", seed, roughness, filled = true, style, ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <div ref={ref} className={cn("relative overflow-visible rounded-xl bg-transparent p-4 text-[var(--chalk-app-text)]", className)} style={mergeStyle(style)} {...props}>
      <ChalkChrome className="absolute inset-0 h-full w-full" filled={filled} focusStroke={stroke} radius={12} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkPanel.displayName = "ChalkPanel";
