import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { ChalkChrome } from "./ChalkChrome";
import { mergeStyle, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly tone?: ChalkTone;
  readonly size?: "sm" | "md" | "lg";
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

const SIZE_CLASSES = { sm: "size-8", md: "size-10", lg: "size-12" } as const;

export const ChalkIconButton = forwardRef<HTMLButtonElement, ChalkIconButtonProps>(function ChalkIconButton({ className, children, disabled, tone = "neutral", size = "md", seed, roughness, style, type = "button", ...props }, ref) {
  const stroke = TONE_STROKES[tone];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      data-chalk-tone={tone}
      data-chalk-size={size}
      aria-label={props["aria-label"]}
      className={cn("group relative inline-grid shrink-0 place-items-center rounded-md text-[var(--chalk-app-text)] outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55", SIZE_CLASSES[size], className)}
      style={mergeStyle(style)}
      {...props}
    >
      <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} focusStroke={stroke} radius={7} roughness={roughness} seed={seed} stroke={stroke} />
      <span className="relative z-[1] grid place-items-center">{children}</span>
    </button>
  );
});

ChalkIconButton.displayName = "ChalkIconButton";
