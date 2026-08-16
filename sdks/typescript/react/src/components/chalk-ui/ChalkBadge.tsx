import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
  readonly dot?: boolean;
  readonly count?: number;
  readonly max?: number;
  readonly showZero?: boolean;
}

export const ChalkBadge = forwardRef<HTMLSpanElement, ChalkBadgeProps>(function ChalkBadge({ children, className, tone = "neutral", seed, roughness, dot = false, count, max = 99, showZero = false, ...props }, ref) {
  if (!showZero && count === 0 && !dot) return children ? <>{children}</> : null;
  const content = dot ? null : count !== undefined && count > max ? `${max}+` : (count ?? children);
  const stroke = TONE_STROKES[tone];
  return (
    <span ref={ref} className={cn("relative inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-semibold text-[var(--chalk-app-text)]", dot && "size-3 min-h-0 min-w-0 p-0", className)} data-chalk-tone={tone} {...props}>
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} filled={!dot} focusStroke={stroke} radius={dot ? 8 : 10} roughness={roughness} seed={seed} stroke={stroke} />
      {content === null ? null : <span className="relative z-[1]">{content}</span>}
    </span>
  );
});

ChalkBadge.displayName = "ChalkBadge";
