import { forwardRef, type ReactNode, type SelectHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, type ChalkTone } from "./common";

export interface ChalkSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly tone?: ChalkTone;

  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
}

export const ChalkSelect = forwardRef<HTMLSelectElement, ChalkSelectProps>(function ChalkSelect({ children, className, label, wrapperClassName, tone = "neutral", style, ...props }, ref) {
  const control = (
    <span className={cn(cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-10 rounded-md"), wrapperClassName)}>
      <select ref={ref} className={cn("relative block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text,var(--chalk-text))] outline-none disabled:cursor-not-allowed disabled:opacity-60", className)} style={style} {...props}>
        {children}
      </select>
    </span>
  );
  return label ? (
    <label className={cn("block text-sm", "text-[var(--chalk-app-text,var(--chalk-text))]")}>
      <span className="mb-1 block">{label}</span>
      {control}
    </label>
  ) : (
    control
  );
});

ChalkSelect.displayName = "ChalkSelect";
