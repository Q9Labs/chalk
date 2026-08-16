import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
}

export const ChalkCheckbox = forwardRef<HTMLInputElement, ChalkCheckboxProps>(function ChalkCheckbox({ children, className, label, wrapperClassName, seed, roughness, tone = "accent", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <label className={cn("group inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm text-[var(--chalk-app-text)]", wrapperClassName)}>
      <span className="relative size-5 shrink-0">
        <input ref={ref} {...props} type="checkbox" className={cn("peer absolute inset-0 z-[2] size-full cursor-pointer opacity-0", className)} />
        <ChalkChrome className="absolute inset-0 h-full w-full" focusStroke={stroke} radius={5} roughness={roughness} seed={seed} stroke={stroke} />
        <ChalkChrome className="pointer-events-none absolute inset-0 h-full w-full opacity-0 transition-opacity peer-checked:opacity-100" focusStroke={stroke} part="check" shape="check" roughness={roughness} seed={seed === undefined ? undefined : `${String(seed)}-check`} stroke={stroke} />
      </span>
      {(label ?? children) ? <span>{label ?? children}</span> : null}
    </label>
  );
});

ChalkCheckbox.displayName = "ChalkCheckbox";
