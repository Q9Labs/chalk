import * as React from "react";

import { cn } from "./lib/utils";

export interface ProgressBarProps {
  readonly value: number;
  readonly max?: number;
  readonly showLabel?: boolean;
  readonly variant?: "default" | "success" | "warning" | "danger";
  readonly size?: "sm" | "md" | "lg";
  readonly animated?: boolean;
  readonly className?: string;
}

function ProgressBar({ value, max = 100, showLabel = false, variant = "default", size = "md", animated = false, className }: ProgressBarProps): React.JSX.Element {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className={cn("w-full", className)}>
      {showLabel ? (
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{Math.round(percentage)}%</span>
        </div>
      ) : null}
      <div className={cn("w-full overflow-hidden rounded-full bg-muted", size === "sm" && "h-1", size === "md" && "h-2", size === "lg" && "h-4")}>
        <div
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          className={cn("h-full rounded-full bg-primary transition-all", variant === "success" && "bg-green-500", variant === "warning" && "bg-yellow-500", variant === "danger" && "bg-destructive", animated && "animate-pulse")}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

export { ProgressBar };
