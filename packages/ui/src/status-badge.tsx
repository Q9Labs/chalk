import * as React from "react";

import { cn } from "./lib/utils";

export type StatusBadgeStatus = "neutral" | "info" | "success" | "warning" | "danger" | "error" | "unknown";

export interface StatusBadgeProps extends React.ComponentPropsWithoutRef<"span"> {
  label?: React.ReactNode;
  status?: StatusBadgeStatus;
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge({ children, className, label, status = "neutral", ...props }, ref) {
  return (
    <span ref={ref} data-slot="status-badge" data-status={status} className={cn("chalk-ui-status-badge", className)} {...props}>
      {label ?? children ?? status}
    </span>
  );
});

export { StatusBadge };
