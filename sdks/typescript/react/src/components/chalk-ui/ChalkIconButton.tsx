import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../utils/cn";
import type { ChalkTone } from "./common";
export interface ChalkIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly tone?: ChalkTone;
  readonly size?: "sm" | "md" | "lg";
}
export const ChalkIconButton = forwardRef<HTMLButtonElement, ChalkIconButtonProps>(function ChalkIconButton({ className, children, tone = "neutral", size = "md", type = "button", ...props }, ref) {
  return (
    <button ref={ref} type={type} data-part="icon-button" data-chalk-tone={tone} data-chalk-size={size} className={cn("chalk-icon-button", className)} {...props}>
      {children}
    </button>
  );
});
