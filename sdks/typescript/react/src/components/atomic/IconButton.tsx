import React from "react";
import type { HapticInput } from "../../internal/useHaptics";
import { useHaptics } from "../../internal/useHaptics";
import { cn } from "../../utils/cn";

interface IconButtonProps {
  icon: React.ReactNode;
  size?: "sm" | "md" | "lg";
  variant?: "default" | "ghost" | "outline";
  onClick?: () => void;
  disabled?: boolean;
  haptic?: HapticInput | false;
  "aria-label": string;
  className?: string;
}

const sizeClasses = {
  sm: "h-8 w-8 p-1.5",
  md: "h-10 w-10 p-2",
  lg: "h-12 w-12 p-3",
};

const variantClasses = {
  default: "bg-[var(--chalk-stage)] text-[var(--chalk-text)] hover:bg-[var(--chalk-stage)] shadow-sm",
  ghost: "bg-transparent text-[var(--chalk-muted-text)] hover:bg-[var(--chalk-stage)] hover:text-[var(--chalk-text)]",
  outline: "border border-[var(--chalk-line)] bg-transparent text-[var(--chalk-text)] hover:bg-[var(--chalk-stage)]",
};

export const IconButton = React.memo(
  React.forwardRef<HTMLButtonElement, IconButtonProps>(({ icon, size = "md", variant = "default", onClick, disabled = false, haptic = "selection", "aria-label": ariaLabel, className }, ref) => {
    const { trigger } = useHaptics({
      enabled: !disabled && haptic !== false,
    });

    const handleClick = React.useCallback(() => {
      if (haptic !== false) {
        void trigger(haptic);
      }

      onClick?.();
    }, [haptic, onClick, trigger]);

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={cn("inline-flex items-center justify-center rounded-md transition-colors duration-200", sizeClasses[size], variantClasses[variant], disabled && "cursor-not-allowed opacity-50", className)}
        aria-label={ariaLabel}
      >
        {icon}
      </button>
    );
  }),
);

IconButton.displayName = "IconButton";
