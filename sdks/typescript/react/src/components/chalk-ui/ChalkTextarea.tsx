import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly wrapperClassName?: string;
}

export const ChalkTextarea = forwardRef<HTMLTextAreaElement, ChalkTextareaProps>(function ChalkTextarea({ className, wrapperClassName, seed, roughness, tone = "neutral", style, ...props }, ref) {
  const skin = useSkin();
  const stroke = TONE_STROKES[tone];
  return (
    <span className={cn(skin === "classic" ? cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-24 rounded-md") : "group relative block min-h-24", wrapperClassName)}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={8} roughness={roughness} seed={seed} stroke={stroke} />
      <textarea
        ref={ref}
        className={cn(
          skin === "classic"
            ? "relative block min-h-24 w-full resize-y rounded-md border-0 bg-transparent px-3 py-2 text-sm leading-6 text-[var(--chalk-app-text,var(--chalk-text))] outline-none placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] disabled:cursor-not-allowed disabled:opacity-60"
            : "relative z-[1] block min-h-24 w-full resize-y rounded-md border-0 bg-transparent px-3 py-2 text-sm leading-6 text-[var(--chalk-app-text)] outline-none placeholder:text-[var(--chalk-app-text-muted)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkTextarea.displayName = "ChalkTextarea";
