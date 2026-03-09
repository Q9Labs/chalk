import React from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: "text" | "circular" | "rectangular" | "rounded";
  animation?: "pulse" | "wave" | "none";
  className?: string;
}

export const Skeleton = React.memo<SkeletonProps>(({ width, height, variant = "text", animation = "pulse", className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const variantClasses = {
    text: "rounded-sm",
    circular: "rounded-full",
    rectangular: "rounded-none",
    rounded: "rounded-md",
  };

  const animationClasses = {
    pulse: !prefersReducedMotion ? "animate-pulse" : "",
    wave: !prefersReducedMotion ? "animate-pulse" : "",
    none: "",
  };

  return (
    <div
      className={cn("bg-muted", variantClasses[variant], animationClasses[animation], className)}
      style={{
        width: width ?? (variant === "text" ? "100%" : undefined),
        height: height ?? (variant === "text" ? "1em" : undefined),
      }}
      aria-hidden="true"
    />
  );
});

Skeleton.displayName = "Skeleton";
