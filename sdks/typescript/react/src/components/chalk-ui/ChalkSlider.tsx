import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";

import { cn } from "../../utils/cn";
import { type ChalkTone } from "./common";

export interface ChalkSliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  readonly tone?: ChalkTone;

  readonly label?: ReactNode;
  readonly wrapperClassName?: string;
  readonly orientation?: "horizontal" | "vertical";
}

export const ChalkSlider = forwardRef<HTMLInputElement, ChalkSliderProps>(function ChalkSlider({ className, defaultValue, label, min, max, orientation = "horizontal", tone = "accent", value, wrapperClassName, style, ...props }, ref) {
  const control = (
    <span
      className={cn(
        "relative block rounded-md bg-[var(--chalk-app-stage,var(--chalk-stage))] p-1 focus-within:ring-2 focus-within:ring-[var(--chalk-app-control-active-line,var(--chalk-focus))] focus-within:ring-offset-1 focus-within:ring-offset-[var(--chalk-app-canvas,var(--chalk-canvas))]",
        orientation === "vertical" ? "h-32 w-6" : "h-6 w-full",
        wrapperClassName,
      )}
    >
      <input ref={ref} type="range" min={min} max={max} value={value} defaultValue={defaultValue} aria-orientation={orientation} className={cn("relative block size-full cursor-pointer accent-[var(--chalk-app-control-primary,var(--chalk-accent))]", className)} style={style} {...props} />
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

ChalkSlider.displayName = "ChalkSlider";
