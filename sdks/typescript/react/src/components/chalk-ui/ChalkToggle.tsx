import { forwardRef, useState, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { mergeStyle, TONE_STROKES, type ChalkSeed, type ChalkTone } from "./common";

export interface ChalkToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-checked" | "aria-pressed"> {
  readonly pressed?: boolean;
  readonly defaultPressed?: boolean;
  readonly onPressedChange?: (pressed: boolean) => void;
  readonly tone?: ChalkTone;
  readonly seed?: ChalkSeed;
  readonly roughness?: number;
}

export const ChalkToggle = forwardRef<HTMLButtonElement, ChalkToggleProps>(function ChalkToggle({ className, children, pressed, defaultPressed = false, onPressedChange, onClick, disabled, tone = "accent", seed, roughness, style, type = "button", ...props }, ref) {
  const [uncontrolledPressed, setUncontrolledPressed] = useState(defaultPressed);
  const isPressed = pressed ?? uncontrolledPressed;
  const trackColor = isPressed ? TONE_STROKES[tone] : "var(--chalk-app-control-group,var(--chalk-app-control,var(--chalk-surface)))";
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
      role="switch"
      disabled={disabled}
      aria-checked={isPressed}
      data-chalk-tone={tone}
      data-pressed={isPressed ? "true" : "false"}
      data-roughness={roughness}
      data-seed={seed === undefined ? undefined : String(seed)}
      className={cn(
        "group relative inline-flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-0.5 outline-none transition-[background-color,box-shadow,opacity] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))] disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none",
        className,
      )}
      style={mergeStyle({
        backgroundColor: trackColor,
        boxShadow: isPressed ? "inset 0 0 0 1px color-mix(in srgb, currentColor 12%, transparent)" : "inset 0 0 0 1px var(--chalk-app-line,var(--chalk-line))",
        ...style,
      })}
      onClick={handleClick}
      {...props}
    >
      <span aria-hidden="true" className={cn("size-[27px] rounded-full bg-white shadow-[0_2px_5px_rgba(15,23,42,0.28),0_0_0_0.5px_rgba(15,23,42,0.12)] transition-transform duration-[280ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none", isPressed && "translate-x-5")} />
      {children ? <span className="sr-only">{children}</span> : null}
    </button>
  );
});

ChalkToggle.displayName = "ChalkToggle";
