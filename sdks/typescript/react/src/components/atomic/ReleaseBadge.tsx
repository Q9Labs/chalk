import React from "react";
import { cn } from "../../utils/cn";

export interface ReleaseBadgeProps {
  type: "major" | "minor" | "patch";
  className?: string;
}

const typeConfig = {
  major: {
    label: "Major",
    className: "bg-[var(--chalk-danger-surface)] text-[var(--chalk-danger)] border-[var(--chalk-danger)]",
  },
  minor: {
    label: "Minor",
    className: "bg-[var(--chalk-stage)] text-[var(--chalk-accent)] border-[var(--chalk-accent)]",
  },
  patch: {
    label: "Patch",
    className: "bg-[var(--chalk-stage)] text-[var(--chalk-muted-text)] border-[var(--chalk-line)]",
  },
} as const;

export const ReleaseBadge = React.memo<ReleaseBadgeProps>(({ type, className }) => {
  const config = typeConfig[type];

  return <span className={cn("inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border", config.className, className)}>{config.label}</span>;
});

ReleaseBadge.displayName = "ReleaseBadge";
