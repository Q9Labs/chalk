import React from "react";
import { cn } from "../../utils/cn";

export interface NameTagProps {
  name: string;
  role?: "host" | "co-host" | "participant";
  isLocal?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const roleColors = {
  host: "var(--accent)",
  "co-host": "#8b5cf6",
  participant: "transparent",
};

const sizeClasses = {
  sm: "text-xs px-1.5 py-0.5",
  md: "text-sm px-2 py-1",
  lg: "text-base px-3 py-1.5",
};

export const NameTag = React.memo(({ name, role = "participant", isLocal = false, size = "md", className }: NameTagProps) => {
  return (
    <div className={cn("inline-flex max-w-full items-center gap-2 rounded-lg text-white", sizeClasses[size], className)}>
      <span className="truncate font-semibold text-lg tracking-tight">{name}</span>
      {isLocal && <span className="text-xs text-white/80 whitespace-nowrap">(You)</span>}
      {role !== "participant" && (
        <span className="rounded-[var(--chalk-border-radius-sm)] px-1.5 py-0.5 text-[10px] uppercase font-bold tracking-wider text-white" style={{ backgroundColor: roleColors[role] }}>
          {role}
        </span>
      )}
    </div>
  );
});

NameTag.displayName = "NameTag";
