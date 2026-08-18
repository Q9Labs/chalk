import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_PANEL_CLASSES, classicTonePanelClasses, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkAlertProps extends HTMLAttributes<HTMLDivElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkAlert = forwardRef<HTMLDivElement, ChalkAlertProps>(function ChalkAlert({ children, className, seed, roughness, style, tone = "danger", role = "alert", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      className={cn(
        skin === "classic" ? cn(CLASSIC_PANEL_CLASSES, classicTonePanelClasses(tone), "rounded-lg px-4 py-3 text-sm shadow-[var(--chalk-app-shadow-sm,var(--chalk-shadow))]") : "group relative overflow-visible rounded-lg bg-transparent px-4 py-3 text-sm text-[var(--chalk-app-text)]",
        className,
      )}
      role={role}
      style={{ position: "relative", ...style }}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled focusStroke={stroke} radius={8} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">{children}</div>
    </div>
  );
});

ChalkAlert.displayName = "ChalkAlert";
