import React from "react";
import { Tooltip } from "@q9labsai/chalk-ui";
import type { HapticInput } from "../../internal/useHaptics";
import { useHaptics } from "../../internal/useHaptics";
import { cn } from "../../utils/cn";
import { ChalkIconButton, type ChalkSeed } from "../chalk-ui";

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
  seed?: ChalkSeed;
  "data-tour"?: string;
  ref?: React.Ref<HTMLButtonElement>;
}

export const ControlBarButton = React.memo(
  ({ icon, label, active = false, danger = false, disabled = false, size = "md", showLabel = false, inlineLabel, hideTooltip = false, noBorder = false, onClick, className, haptic = "selection", activeClassName, seed, "data-tour": dataTour, ref }: ControlBarButtonProps) => {
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
      <ChalkIconButton
        ref={ref}
        onClick={handleClick}
        disabled={disabled}
        data-tour={dataTour}
        seed={seed}
        size={size}
        tone={danger ? "danger" : active ? "accent" : "neutral"}
        className={cn("chalk-button-tactile transition-all duration-300 ease-out", inlineLabel && "gap-2.5", "text-[var(--chalk-app-text)]", noBorder && "opacity-95", active && activeClassName, className)}
        aria-label={label}
        aria-pressed={active}
      >
        {icon}
        {inlineLabel ? <span className="max-sm:hidden">{inlineLabel}</span> : null}
      </ChalkIconButton>
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

ControlBarButton.displayName = "ControlBarButton";
