import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_PANEL_CLASSES, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkDialogPanelProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly filled?: boolean;
}

export const ChalkDialogPanel = forwardRef<HTMLDivElement, ChalkDialogPanelProps>(function ChalkDialogPanel({ children, className, filled = true, role = "dialog", seed, roughness, style, tone = "neutral", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      className={cn(skin === "classic" ? cn(CLASSIC_PANEL_CLASSES, "rounded-xl p-5 text-[var(--chalk-app-text,var(--chalk-text))] shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]") : "group relative overflow-visible rounded-xl bg-transparent p-5 text-[var(--chalk-app-text)]", className)}
      role={role}
      style={{ position: "relative", ...style }}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled={filled} focusStroke={stroke} radius={12} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkDialogPanel.displayName = "ChalkDialogPanel";
