import * as React from "react";

import { cn } from "./lib/utils";

export interface SkeletonProps {
  readonly width?: string | number;
  readonly height?: string | number;
  readonly variant?: "text" | "circular" | "rectangular" | "rounded";
  readonly animation?: "pulse" | "wave" | "none";
  readonly className?: string;
}

function Skeleton({ width, height, variant = "text", animation = "pulse", className }: SkeletonProps): React.JSX.Element {
  return (
    <div
      className={cn("bg-muted", variant === "text" && "rounded-sm", variant === "circular" && "rounded-full", variant === "rounded" && "rounded-md", animation === "pulse" && "animate-pulse", animation === "wave" && "animate-pulse", className)}
      style={{ width: width ?? (variant === "text" ? "100%" : undefined), height: height ?? (variant === "text" ? "1em" : undefined) }}
      aria-hidden="true"
    />
  );
}

export { Skeleton };
