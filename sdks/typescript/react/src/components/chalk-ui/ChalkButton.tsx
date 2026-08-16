import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { mergeStyle, TONE_FILLS, TONE_STROKES, type ChalkButtonVariant, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly variant?: ChalkButtonVariant;
  readonly tone?: ChalkTone;
  readonly loading?: boolean;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkButton = forwardRef<HTMLButtonElement, ChalkButtonProps>(function ChalkButton({ className, children, disabled = false, loading = false, variant = "outline", tone = "neutral", seed, roughness, style, type = "button", ...props }, ref) {
  const isDisabled = disabled || loading;
  const stroke = TONE_STROKES[tone];
  const fill = TONE_FILLS[tone];
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-chalk-variant={variant}
      data-chalk-tone={tone}
      data-loading={loading ? "true" : undefined}
      className={cn(
        "group relative inline-flex min-h-10 items-center justify-center gap-2 overflow-visible rounded-md px-4 py-2 text-sm font-medium text-[var(--chalk-app-text)] outline-none transition-[filter,transform] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55",
        variant === "ghost" ? "bg-transparent" : "bg-transparent",
        className,
      )}
      style={mergeStyle(style)}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={fill} filled={variant === "solid"} focusStroke={stroke} radius={8} roughness={roughness} scribble={variant === "scribble"} seed={seed} stroke={stroke} />
      <span className="relative z-[1] inline-flex items-center justify-center gap-2">
        {loading ? <span aria-hidden="true" className="size-3 rounded-full bg-current opacity-70" /> : null}
        {children}
      </span>
    </button>
  );
});

ChalkButton.displayName = "ChalkButton";
