import * as React from "react";

import { cn } from "./lib/utils";

export interface SpinnerProps {
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly color?: string;
  readonly className?: string;
}

function Spinner({ size = "md", color, className }: SpinnerProps): React.JSX.Element {
  return (
    <span
      className={cn("inline-block animate-spin rounded-full border-2 border-current border-t-transparent text-primary", size === "sm" && "h-4 w-4", size === "md" && "h-6 w-6", size === "lg" && "h-8 w-8", size === "xl" && "h-12 w-12", className)}
      style={color ? { color } : undefined}
      role="status"
      aria-label="Loading"
    />
  );
}

export { Spinner };
