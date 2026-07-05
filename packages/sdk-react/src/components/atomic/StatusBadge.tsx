import React from "react";
import { cn } from "../../utils/cn";
import { CircleIcon, Radio01Icon, TextIcon, Alert02Icon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";

export interface StatusBadgeProps {
  status: "recording" | "live" | "transcribing" | "connecting" | "reconnecting";
  pulse?: boolean;
  size?: "sm" | "md";
  className?: string;
}

const config = {
  recording: {
    icon: CircleIcon,
    text: "REC",
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
  },
  live: {
    icon: Radio01Icon,
    text: "LIVE",
    colorClass: "text-destructive",
    bgClass: "bg-destructive/10",
  },
  transcribing: {
    icon: TextIcon,
    text: "CC",
    colorClass: "text-primary",
    bgClass: "bg-primary/10",
  },
  connecting: {
    icon: Alert02Icon,
    text: "CONNECTING...",
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
  },
  reconnecting: {
    icon: Alert02Icon,
    text: "RECONNECTING...",
    colorClass: "text-warning",
    bgClass: "bg-warning/10",
  },
};

export const StatusBadge = React.memo(({ status, pulse = false, size = "md", className }: StatusBadgeProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { icon: Icon, text, colorClass, bgClass } = config[status];

  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-sm font-medium", size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs", pulse && !prefersReducedMotion && "animate-pulse", colorClass, bgClass, className)} role="status" aria-label={status}>
      <Icon size={size === "sm" ? 10 : 12} className={cn(status === "recording" && "fill-current")} />
      <span>{text}</span>
    </div>
  );
});

StatusBadge.displayName = "StatusBadge";
