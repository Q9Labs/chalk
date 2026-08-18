import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_PANEL_CLASSES, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkTooltipPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkTooltipPanel = forwardRef<HTMLDivElement, ChalkTooltipPanelProps>(function ChalkTooltipPanel({ children, className, seed, roughness, style, tone = "neutral", role = "tooltip", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      className={cn(
        skin === "classic" ? cn(CLASSIC_PANEL_CLASSES, "max-w-xs rounded-md px-3 py-2 text-xs text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-xs,var(--chalk-shadow))]") : "group relative max-w-xs rounded-md bg-transparent px-3 py-2 text-xs text-[var(--chalk-app-text)]",
        className,
      )}
      role={role}
      style={{ position: "relative", ...style }}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled focusStroke={stroke} radius={7} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkTooltipPanel.displayName = "ChalkTooltipPanel";
