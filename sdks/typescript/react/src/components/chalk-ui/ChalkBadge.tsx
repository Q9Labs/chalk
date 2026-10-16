import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { classicToneSurfaceClasses, type ChalkTone } from "./common";

export interface ChalkBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: ChalkTone;

  readonly dot?: boolean;
  readonly count?: number;
  readonly max?: number;
  readonly showZero?: boolean;
}

export const ChalkBadge = forwardRef<HTMLSpanElement, ChalkBadgeProps>(function ChalkBadge({ children, className, tone = "neutral", dot = false, count, max = 99, showZero = false, ...props }, ref) {
  if (!showZero && count === 0 && !dot) return children ? <>{children}</> : null;
  const content = dot ? null : count !== undefined && count > max ? `${max}+` : (count ?? children);
  return (
    <span ref={ref} className={cn(cn(classicToneSurfaceClasses(tone), "inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-xs font-semibold"), dot && "size-3 min-h-0 min-w-0 p-0", className)} data-chalk-tone={tone} {...props}>
      {content === null ? null : <span className="relative z-[1]">{content}</span>}
    </span>
  );
});

ChalkBadge.displayName = "ChalkBadge";
