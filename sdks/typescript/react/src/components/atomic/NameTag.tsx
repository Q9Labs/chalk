import React from "react";
import { cn } from "../../utils/cn";

export interface NameTagProps {
  name: string;
  isLocal?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeClasses = {
  sm: "text-xs px-1.5 py-0.5",
  md: "text-sm px-2 py-1",
  lg: "text-base px-3 py-1.5",
};

export const NameTag = React.memo(({ name, isLocal = false, size = "md", className }: NameTagProps) => {
  return (
    <div className={cn("inline-flex max-w-full items-center gap-2 rounded-lg text-[var(--chalk-accent-text)]", sizeClasses[size], className)}>
      <span className="truncate font-semibold text-lg tracking-tight">{name}</span>
      {isLocal && <span className="text-xs text-[var(--chalk-accent-text)] whitespace-nowrap">(You)</span>}
    </div>
  );
});

NameTag.displayName = "NameTag";
