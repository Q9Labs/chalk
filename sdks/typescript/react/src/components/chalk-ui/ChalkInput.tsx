import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, type ChalkTone } from "./common";

export interface ChalkInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "color"> {
  readonly tone?: ChalkTone;

  readonly wrapperClassName?: string;
}

export const ChalkInput = forwardRef<HTMLInputElement, ChalkInputProps>(function ChalkInput({ className, wrapperClassName, tone = "neutral", style, type = "text", ...props }, ref) {
  return (
    <span className={cn(cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-10 rounded-md"), wrapperClassName)}>
      <input
        ref={ref}
        type={type}
        className={cn(
          "relative block h-full min-h-10 w-full rounded-md border-0 bg-transparent px-3 py-2 text-sm text-[var(--chalk-app-text,var(--chalk-text))] outline-none placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkInput.displayName = "ChalkInput";
