import { forwardRef, type HTMLAttributes } from "react";

import { cn } from "../../utils/cn";

export interface ChalkControlGroupProps extends HTMLAttributes<HTMLDivElement> {
  readonly orientation?: "horizontal" | "vertical";
}

export const ChalkControlGroup = forwardRef<HTMLDivElement, ChalkControlGroupProps>(function ChalkControlGroup({ className, orientation = "horizontal", role = "group", ...props }, ref) {
  return <div ref={ref} role={role} data-chalk-control-group={orientation} className={cn("flex gap-2", orientation === "vertical" ? "flex-col items-stretch" : "flex-row items-center", className)} {...props} />;
});

ChalkControlGroup.displayName = "ChalkControlGroup";
