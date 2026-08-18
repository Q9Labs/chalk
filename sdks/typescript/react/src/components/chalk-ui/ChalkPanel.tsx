import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_FOCUS_CLASSES, CLASSIC_PANEL_CLASSES, mergeStyle, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly filled?: boolean;
  readonly contentClassName?: string;
}

export const ChalkPanel = forwardRef<HTMLDivElement, ChalkPanelProps>(function ChalkPanel({ children, className, contentClassName, tone = "neutral", seed, roughness, filled = true, style, ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      className={cn(
        skin === "classic" ? cn(CLASSIC_PANEL_CLASSES, CLASSIC_FOCUS_CLASSES, "relative rounded-xl p-4 text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]") : "relative overflow-visible rounded-xl bg-transparent p-4 text-[var(--chalk-app-text)]",
        className,
      )}
      style={mergeStyle(style)}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" filled={filled} focusStroke={stroke} radius={12} roughness={roughness} seed={seed} stroke={stroke} />
      <div className={cn("relative z-[1]", contentClassName)}>{children}</div>
    </div>
  );
});

ChalkPanel.displayName = "ChalkPanel";
