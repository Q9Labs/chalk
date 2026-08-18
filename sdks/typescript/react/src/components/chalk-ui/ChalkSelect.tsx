import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
}

export const ChalkSelect = forwardRef<HTMLSelectElement, ChalkSelectProps>(function ChalkSelect({ children, className, label, wrapperClassName, seed, roughness, tone = "neutral", style, ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  const control = (
    <span className={cn(skin === "classic" ? cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-10 rounded-md") : "group relative block min-h-10", wrapperClassName)}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={6} roughness={roughness} seed={seed} stroke={stroke} />
      <select
        ref={ref}
        className={cn(
          skin === "classic"
            ? "relative block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text,var(--chalk-text))] outline-none disabled:cursor-not-allowed disabled:opacity-60"
            : "relative z-[1] block h-full min-h-10 w-full appearance-none rounded-md border-0 bg-transparent px-3 py-2 pr-8 text-sm text-[var(--chalk-app-text)] outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      >
        {children}
      </select>
      {skin === "chalk" ? (
        <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 z-[2] -translate-y-1/2 text-[var(--chalk-app-text-muted)]">
          ⌄
        </span>
      ) : null}
    </span>
  );
  return label ? (
    <label className={cn("block text-sm", skin === "classic" ? "text-[var(--chalk-app-text,var(--chalk-text))]" : "text-[var(--chalk-app-text)]")}>
      <span className="mb-1 block">{label}</span>
      {control}
    </label>
  ) : (
    control
  );
});

ChalkSelect.displayName = "ChalkSelect";
