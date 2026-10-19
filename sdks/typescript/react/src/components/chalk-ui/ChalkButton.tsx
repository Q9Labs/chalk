import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../utils/cn";
import type { ChalkButtonVariant, ChalkTone } from "./common";
export interface ChalkButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly variant?: ChalkButtonVariant;
  readonly tone?: ChalkTone;
  readonly loading?: boolean;
}
export const ChalkButton = forwardRef<HTMLButtonElement, ChalkButtonProps>(function ChalkButton({ className, children, disabled, loading = false, variant = "outline", tone = "neutral", type = "button", ...props }, ref) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} aria-busy={loading || undefined} data-part="pill-button" data-chalk-variant={variant} data-chalk-tone={tone} className={cn("chalk-pill-button", className)} {...props}>
      {children}
    </button>
  );
});
