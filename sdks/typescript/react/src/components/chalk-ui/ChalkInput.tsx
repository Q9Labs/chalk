import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "color"> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly wrapperClassName?: string;
}

export const ChalkInput = forwardRef<HTMLInputElement, ChalkInputProps>(function ChalkInput({ className, wrapperClassName, seed, roughness, tone = "neutral", style, type = "text", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <span className={cn("group relative block min-h-10", wrapperClassName)}>
      <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={6} roughness={roughness} seed={seed} stroke={stroke} />
      <input
        ref={ref}
        type={type}
        className={cn("relative z-[1] block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text)] outline-none placeholder:text-[var(--chalk-app-text-muted)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60", className)}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkInput.displayName = "ChalkInput";
