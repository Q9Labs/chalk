import { forwardRef, useState, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ChalkChrome } from "./ChalkChrome";
import { classicButtonClasses, mergeStyle, TONE_FILLS, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  readonly pressed?: boolean;
  readonly defaultPressed?: boolean;
  readonly onPressedChange?: (pressed: boolean) => void;
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkToggle = forwardRef<HTMLButtonElement, ChalkToggleProps>(function ChalkToggle({ className, children, pressed, defaultPressed = false, onPressedChange, onClick, disabled, tone = "accent", seed, roughness, style, type = "button", ...props }, ref) {
  const skin = useSkin();
  const [uncontrolledPressed, setUncontrolledPressed] = useState(defaultPressed);
  const isPressed = pressed ?? uncontrolledPressed;
  const stroke = TONE_STROKES[tone];
  const handleClick: NonNullable<ButtonHTMLAttributes<HTMLButtonElement>["onClick"]> = (event) => {
    if (disabled) return;
    const next = !isPressed;
    if (pressed === undefined) setUncontrolledPressed(next);
    onPressedChange?.(next);
    onClick?.(event);
  };
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-pressed={isPressed}
      data-pressed={isPressed ? "true" : "false"}
      className={cn(
        skin === "classic"
          ? cn(
              classicButtonClasses(isPressed ? "solid" : "outline", tone),
              "inline-flex min-h-9 min-w-16 items-center justify-center rounded-full px-3 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))] disabled:cursor-not-allowed disabled:opacity-55",
            )
          : "group relative inline-flex min-h-9 min-w-16 items-center justify-center rounded-full px-3 text-sm text-[var(--chalk-app-text)] outline-none focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-55",
        className,
      )}
      style={mergeStyle(style)}
      onClick={handleClick}
      {...props}
    >
      {skin === "chalk" ? <ChalkChrome className="absolute inset-0 h-full w-full" filled={isPressed} fill={TONE_FILLS[tone]} focusStroke={stroke} part="track" radius={18} roughness={roughness} seed={seed} stroke={stroke} /> : null}
      <span aria-hidden="true" className={cn("absolute left-2 top-1/2 z-[1] size-5 -translate-y-1/2 rounded-full transition-transform", skin === "classic" && "border border-[var(--chalk-app-line,var(--chalk-line))] bg-[var(--chalk-app-control,var(--chalk-surface))]", isPressed && "translate-x-7")}>
        {skin === "chalk" ? <ChalkChrome className="absolute inset-0 h-full w-full" fill={TONE_FILLS[tone]} focusStroke={stroke} part="knob" shape="circle" roughness={roughness} seed={seed === undefined ? undefined : `${String(seed)}-knob`} stroke={stroke} /> : null}
      </span>
      {skin === "chalk" && isPressed ? <ChalkChrome className="pointer-events-none absolute right-2 top-1/2 z-[2] size-3 -translate-y-1/2" focusStroke={stroke} part="check" shape="check" roughness={roughness} seed={seed === undefined ? undefined : `${String(seed)}-check`} stroke={stroke} /> : null}
      <span className="relative z-[3]">{children}</span>
    </button>
  );
});

ChalkToggle.displayName = "ChalkToggle";
