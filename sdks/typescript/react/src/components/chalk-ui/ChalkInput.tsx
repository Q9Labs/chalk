import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "color"> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly wrapperClassName?: string;
}

export const ChalkInput = forwardRef<HTMLInputElement, ChalkInputProps>(function ChalkInput({ className, wrapperClassName, seed, roughness, tone = "neutral", style, type = "text", ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <span className={cn(skin === "classic" ? cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-10 rounded-md") : "group relative block min-h-10", wrapperClassName)}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={6} roughness={roughness} seed={seed} stroke={stroke} />
      <input
        ref={ref}
        type={type}
        className={cn(
          skin === "classic"
            ? "relative block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text,var(--chalk-text))] outline-none placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] disabled:cursor-not-allowed disabled:opacity-60"
            : "relative z-[1] block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text)] outline-none placeholder:text-[var(--chalk-app-text-muted)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkInput.displayName = "ChalkInput";
