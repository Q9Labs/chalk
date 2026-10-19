import { forwardRef, useState, type ButtonHTMLAttributes } from "react";
import { cn } from "../../utils/cn";
import type { ChalkTone } from "./common";
export interface ChalkToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-checked" | "aria-pressed"> {
  readonly pressed?: boolean;
  readonly defaultPressed?: boolean;
  readonly onPressedChange?: (pressed: boolean) => void;
  readonly tone?: ChalkTone;
}
export const ChalkToggle = forwardRef<HTMLButtonElement, ChalkToggleProps>(function ChalkToggle({ className, children, pressed, defaultPressed = false, onPressedChange, onClick, tone = "success", type = "button", ...props }, ref) {
  const [local, setLocal] = useState(defaultPressed);
  const value = pressed ?? local;
  return (
    <button
      ref={ref}
      type={type}
      role="switch"
      aria-checked={value}
      data-part="switch"
      data-chalk-tone={tone}
      className={cn("chalk-switch", className)}
      onClick={(event) => {
        if (pressed === undefined) setLocal(!value);
        onPressedChange?.(!value);
        onClick?.(event);
      }}
      {...props}
    >
      <span aria-hidden="true" />
      {children ? <span className="sr-only">{children}</span> : null}
    </button>
  );
});
