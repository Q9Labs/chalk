import React from "react";
import type { ChalkHapticInput } from "../../hooks/ui/useHaptics";
import { useHaptics } from "../../hooks/ui/useHaptics";
import { cn } from "../../utils/cn";
import { Tooltip } from "./Tooltip";

interface ControlButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  hideTooltip?: boolean;
  noBorder?: boolean;
  onClick?: () => void;
  className?: string;
  haptic?: ChalkHapticInput | false;
  /** Custom styles when active (overrides default active styles) */
  activeClassName?: string;
  "data-tour"?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

export const ControlButton = React.memo(({ icon, label, active = false, danger = false, disabled = false, size = "md", showLabel = false, hideTooltip = false, noBorder = false, onClick, className, haptic = "selection", activeClassName, "data-tour": dataTour, ref }: ControlButtonProps) => {
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
        "text-[var(--foreground)]",
        size === "sm" && "h-9 w-9 rounded-full",
        size === "md" && "h-11 w-11 rounded-full",
        size === "lg" && "h-14 w-14 rounded-full",
        disabled && "cursor-not-allowed opacity-50",
        // Default state
        !disabled && !active && !danger && !noBorder && "bg-[var(--secondary)] shadow-lg hover:brightness-110",
        // No Border state (Ghost)
        !disabled && !active && !danger && noBorder && "bg-[var(--secondary)]",
        // Active state
        !disabled && active && !activeClassName && "bg-[var(--secondary)] border-transparent hover:bg-[var(--accent)]",
        // Custom active state
        !disabled && active && activeClassName && activeClassName,
        // Danger state - vibrant red for visibility
        danger && "bg-[#dc2626] text-white border-transparent hover:bg-[#b91c1c]",
        className,
      )}
      aria-label={label}
      aria-pressed={active}
    >
      {icon}
    </button>
  );

  if (showLabel) {
    return (
      <div className="flex flex-col items-center gap-1">
        {button}
        <span className="text-xs text-[var(--muted-foreground)]">{label}</span>
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
});

ControlButton.displayName = "ControlButton";
