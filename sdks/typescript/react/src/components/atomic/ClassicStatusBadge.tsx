import React from "react";
import { cn } from "../../utils/cn";
import { CircleIcon, Radio01Icon, TextIcon, Alert02Icon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import type { StatusBadgeProps } from "./StatusBadge";

const config = {
  recording: {
    icon: CircleIcon,
    text: "Recording",
    colorClass: "text-[var(--chalk-danger)]",
    bgClass: "bg-[var(--chalk-danger-surface)]",
  },
  live: {
    icon: Radio01Icon,
    text: "Live",
    colorClass: "text-[var(--chalk-danger)]",
    bgClass: "bg-[var(--chalk-danger-surface)]",
  },
  transcribing: {
    icon: TextIcon,
    text: "CC",
    colorClass: "text-[var(--chalk-accent)]",
    bgClass: "bg-[var(--chalk-stage)]",
  },
  connecting: {
    icon: Alert02Icon,
    text: "CONNECTING...",
    colorClass: "text-[var(--chalk-danger)]",
    bgClass: "bg-[var(--chalk-danger-surface)]",
  },
  reconnecting: {
    icon: Alert02Icon,
    text: "RECONNECTING...",
    colorClass: "text-[var(--chalk-danger)]",
    bgClass: "bg-[var(--chalk-danger-surface)]",
  },
};

export const ClassicStatusBadge = React.memo(({ status, pulse = false, size = "md", className }: StatusBadgeProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { icon: Icon, text, colorClass, bgClass } = config[status];

  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-sm font-medium", size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs", pulse && !prefersReducedMotion && "animate-pulse", colorClass, bgClass, className)} role="status" aria-label={status}>
      <Icon size={size === "sm" ? 10 : 12} className={cn(status === "recording" && "fill-current")} />
      <span>{text}</span>
    </div>
  );
});

ClassicStatusBadge.displayName = "ClassicStatusBadge";
