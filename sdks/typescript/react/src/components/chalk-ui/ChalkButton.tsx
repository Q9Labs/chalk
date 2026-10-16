import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_CLASSES, classicButtonClasses, mergeStyle, type ChalkButtonVariant, type ChalkTone } from "./common";

export interface ChalkButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly variant?: ChalkButtonVariant;
  readonly tone?: ChalkTone;
  readonly loading?: boolean;
}

export const ChalkButton = forwardRef<HTMLButtonElement, ChalkButtonProps>(function ChalkButton({ className, children, disabled = false, loading = false, variant = "outline", tone = "neutral", style, type = "button", ...props }, ref) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-chalk-variant={variant}
      data-chalk-tone={tone}
      data-loading={loading ? "true" : undefined}
      className={cn(cn(CLASSIC_FOCUS_CLASSES, classicButtonClasses(variant, tone), "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55"), className)}
      style={mergeStyle(style)}
      {...props}
    >
      <span className="relative z-[1] inline-flex items-center justify-center gap-2">
        {loading ? <span aria-hidden="true" className="size-3 rounded-full bg-current opacity-70" /> : null}
        {children}
      </span>
    </button>
  );
});

ChalkButton.displayName = "ChalkButton";
