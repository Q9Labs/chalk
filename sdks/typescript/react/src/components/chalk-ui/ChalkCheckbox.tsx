import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { type ChalkTone } from "./common";

export interface ChalkCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly tone?: ChalkTone;

  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
}

export const ChalkCheckbox = forwardRef<HTMLInputElement, ChalkCheckboxProps>(function ChalkCheckbox({ children, className, label, wrapperClassName, tone = "accent", ...props }, ref) {
  return (
    <label className={cn("group inline-flex min-h-6 cursor-pointer items-center gap-2 text-sm", "text-[var(--chalk-app-text,var(--chalk-text))]", wrapperClassName)}>
      <span className="relative size-5 shrink-0">
        <input
          ref={ref}
          {...props}
          type="checkbox"
          className={cn("relative z-[2] size-5 cursor-pointer accent-[var(--chalk-app-control-primary,var(--chalk-accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))]", className)}
        />
      </span>
      {(label ?? children) ? <span>{label ?? children}</span> : null}
    </label>
  );
});

ChalkCheckbox.displayName = "ChalkCheckbox";
