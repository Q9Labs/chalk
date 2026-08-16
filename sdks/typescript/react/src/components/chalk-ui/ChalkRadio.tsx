import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkRadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
}

export const ChalkRadio = forwardRef<HTMLInputElement, ChalkRadioProps>(function ChalkRadio({ children, className, label, wrapperClassName, seed, roughness, tone = "accent", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <label className={cn("group inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm text-[var(--chalk-app-text)]", wrapperClassName)}>
      <span className="relative size-5 shrink-0">
        <input ref={ref} {...props} type="radio" className={cn("peer absolute inset-0 z-[2] size-full cursor-pointer opacity-0", className)} />
        <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} part="radio" shape="circle" roughness={roughness} seed={seed} stroke={stroke} />
        <ChalkChrome className="pointer-events-none absolute inset-0 h-full w-full opacity-0 transition-opacity peer-checked:opacity-100" focusStroke={stroke} part="dot" shape="circle" roughness={roughness} seed={seed === undefined ? undefined : `${String(seed)}-dot`} stroke={stroke} />
      </span>
      {(label ?? children) ? <span>{label ?? children}</span> : null}
    </label>
  );
});

ChalkRadio.displayName = "ChalkRadio";
