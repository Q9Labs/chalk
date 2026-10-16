import React from "react";
import type { HapticInput } from "../../internal/useHaptics";
import { ClassicControlBarButton } from "./ClassicControlBarButton";

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

export const ControlBarButton = React.memo((props: ControlBarButtonProps) => {
  return <ClassicControlBarButton {...props} />;
});

ControlBarButton.displayName = "ControlBarButton";
