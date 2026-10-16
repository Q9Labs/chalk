import { forwardRef, type ButtonHTMLAttributes } from "react";

import { cn } from "../../utils/cn";
import { CLASSIC_FOCUS_CLASSES, classicButtonClasses, mergeStyle, type ChalkTone } from "./common";

export interface ChalkIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "color"> {
  readonly tone?: ChalkTone;
  readonly size?: "sm" | "md" | "lg";
}

const SIZE_CLASSES = { sm: "size-8", md: "size-10", lg: "size-12" } as const;

export const ChalkIconButton = forwardRef<HTMLButtonElement, ChalkIconButtonProps>(function ChalkIconButton({ className, children, disabled, tone = "neutral", size = "md", style, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      data-chalk-tone={tone}
      data-chalk-size={size}
      aria-label={props["aria-label"]}
      className={cn(cn(CLASSIC_FOCUS_CLASSES, classicButtonClasses("outline", tone), "inline-grid shrink-0 place-items-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-55"), SIZE_CLASSES[size], className)}
      style={mergeStyle(style)}
      {...props}
    >
      <span className="relative z-[1] grid place-items-center">{children}</span>
    </button>
  );
});

ChalkIconButton.displayName = "ChalkIconButton";
