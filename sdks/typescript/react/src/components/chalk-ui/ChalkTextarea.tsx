import { forwardRef, type TextareaHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_WITHIN_CLASSES, CLASSIC_SURFACE_CLASSES, type ChalkTone } from "./common";

export interface ChalkTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly tone?: ChalkTone;

  readonly wrapperClassName?: string;
}

export const ChalkTextarea = forwardRef<HTMLTextAreaElement, ChalkTextareaProps>(function ChalkTextarea({ className, wrapperClassName, tone = "neutral", style, ...props }, ref) {
  return (
    <span className={cn(cn(CLASSIC_SURFACE_CLASSES, CLASSIC_FOCUS_WITHIN_CLASSES, "relative block min-h-24 rounded-md"), wrapperClassName)}>
      <textarea
        ref={ref}
        className={cn(
          "relative block min-h-24 w-full resize-y rounded-md border-0 bg-transparent px-3 py-2 text-sm leading-6 text-[var(--chalk-app-text,var(--chalk-text))] outline-none placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        style={style}
        {...props}
      />
    </span>
  );
});

ChalkTextarea.displayName = "ChalkTextarea";
