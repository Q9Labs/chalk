import React from "react";
import { Loading01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";

export interface SpinnerProps {
  size?: "sm" | "md" | "lg" | "xl";
  color?: string;
  className?: string;
}

export const Spinner = React.memo<SpinnerProps>(({ size = "md", color, className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const sizeClasses = {
    sm: "w-4 h-4",
    md: "w-6 h-6",
    lg: "w-8 h-8",
    xl: "w-12 h-12",
  };

  return <Loading01Icon className={cn(!prefersReducedMotion && "animate-spin", "text-primary", sizeClasses[size], className)} style={color ? { color } : undefined} role="status" aria-label="Loading" />;
});

Spinner.displayName = "Spinner";
