import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly wrapperClassName?: string;
}

export const ChalkTextarea = forwardRef<HTMLTextAreaElement, ChalkTextareaProps>(function ChalkTextarea({ className, wrapperClassName, seed, roughness, tone = "neutral", style, ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <span className={cn("group relative block min-h-24", wrapperClassName)}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={8} roughness={roughness} seed={seed} stroke={stroke} />
      <textarea
        ref={ref}
        className={cn(
          "relative z-[1] block min-h-24 w-full resize-y rounded-md border-0 bg-transparent px-3 py-2 text-sm leading-6 text-[var(--chalk-app-text)] outline-none placeholder:text-[var(--chalk-app-text-muted)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkTextarea.displayName = "ChalkTextarea";
