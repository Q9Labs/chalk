import React from "react";
import { Tooltip } from "@q9labsai/chalk-ui";
import type { HapticInput } from "../../internal/useHaptics";
import { useHaptics } from "../../internal/useHaptics";
import { cn } from "../../utils/cn";

interface ControlBarButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  inlineLabel?: string;
  hideTooltip?: boolean;
  noBorder?: boolean;
  onClick?: () => void;
  className?: string;
  haptic?: HapticInput | false;
  /** Custom styles when active (overrides default active styles) */
  activeClassName?: string;
  "data-tour"?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

export const ClassicControlBarButton = React.memo(
  ({ icon, label, active = false, danger = false, disabled = false, size = "md", showLabel = false, inlineLabel, hideTooltip = false, noBorder = false, onClick, className, haptic = "selection", activeClassName, "data-tour": dataTour, ref }: ControlBarButtonProps) => {
    const { trigger } = useHaptics({
      enabled: !disabled && haptic !== false,
    });

    const handleClick = React.useCallback(() => {
      if (haptic !== false) {
        void trigger(haptic);
      }

      onClick?.();
    }, [haptic, onClick, trigger]);

    const button = (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        data-tour={dataTour}
        className={cn(
          "chalk-button-tactile group relative flex items-center justify-center transition-all duration-300 ease-out",
          inlineLabel && "gap-2.5",
          "text-[var(--chalk-app-text)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--chalk-app-canvas)]",
          size === "sm" && "h-9 w-9 rounded-full",
          size === "md" && "h-11 w-11 rounded-full",
          size === "lg" && "h-14 w-14 rounded-full",
          disabled && "cursor-not-allowed opacity-50",
          // Default state
          !disabled && !active && !danger && !noBorder && "bg-[var(--chalk-app-control)] shadow-[var(--chalk-app-shadow-control)] hover:bg-[var(--chalk-app-control-hover)]",
          // No Border state (Ghost)
          !disabled && !active && !danger && noBorder && "bg-[var(--chalk-app-control)]",
          // Active state
          !disabled && active && !activeClassName && "border-transparent bg-[var(--chalk-app-control-active)] text-[var(--chalk-app-control-active-text)] hover:bg-[var(--chalk-app-control-hover)]",
          // Custom active state
          !disabled && active && activeClassName && activeClassName,
          // Danger state - vibrant red for visibility
          danger && "border-transparent bg-[var(--chalk-app-danger)] text-white hover:bg-[var(--chalk-app-danger-hover)]",
          className,
        )}
        aria-label={label}
        aria-pressed={active}
      >
        {icon}
        {inlineLabel ? <span className="max-sm:hidden">{inlineLabel}</span> : null}
      </button>
    );

    if (showLabel) {
      return (
        <div className="flex flex-col items-center gap-1">
          {button}
          <span className="text-[var(--chalk-app-text-muted)] text-xs">{label}</span>
        </div>
      );
    }

    if (hideTooltip) {
      return button;
    }

    return (
      <Tooltip content={label} position="top">
        {button}
      </Tooltip>
    );
  },
);

ClassicControlBarButton.displayName = "ClassicControlBarButton";
