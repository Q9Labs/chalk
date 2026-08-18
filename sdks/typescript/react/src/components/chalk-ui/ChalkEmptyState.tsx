import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_PANEL_CLASSES, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkEmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkEmptyState = forwardRef<HTMLDivElement, ChalkEmptyStateProps>(function ChalkEmptyState({ children, className, description, seed, roughness, style, title, tone = "neutral", role = "status", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <div
      ref={ref}
      className={cn(skin === "classic" ? cn(CLASSIC_PANEL_CLASSES, "rounded-xl px-6 py-10 text-center text-[var(--chalk-app-text,var(--chalk-text))]") : "group relative overflow-visible rounded-xl bg-transparent px-6 py-10 text-center text-[var(--chalk-app-text)]", className)}
      role={role}
      style={{ position: "relative", ...style }}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled focusStroke={stroke} radius={12} roughness={roughness} seed={seed} stroke={stroke} />
      <div className="relative z-[1]">
        {title ? <h2 className="text-base font-semibold">{title}</h2> : null}
        {description ? <p className={cn("mt-2 text-sm", skin === "classic" ? "text-[var(--chalk-app-text-muted,var(--chalk-muted-text))]" : "text-[var(--chalk-app-text-muted)]")}>{description}</p> : null}
        {children}
      </div>
    </div>
  );
});

ChalkEmptyState.displayName = "ChalkEmptyState";
