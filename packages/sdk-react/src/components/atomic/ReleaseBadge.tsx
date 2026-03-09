import React from "react";
import { cn } from "../../utils/cn";

export interface ReleaseBadgeProps {
  type: "major" | "minor" | "patch";
  className?: string;
}

const typeConfig = {
  major: {
    label: "Major",
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
  minor: {
    label: "Minor",
    className: "bg-primary/10 text-primary border-primary/20",
  },
  patch: {
    label: "Patch",
    className: "bg-muted text-muted-foreground border-border",
  },
} as const;

export const ReleaseBadge = React.memo<ReleaseBadgeProps>(({ type, className }) => {
  const config = typeConfig[type];

  return <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border", config.className, className)}>{config.label}</span>;
});

ReleaseBadge.displayName = "ReleaseBadge";
