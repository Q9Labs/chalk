import React from "react";
import { cn } from "../../utils/cn";
import { CircleIcon, Radio01Icon, TextIcon, Alert02Icon } from "../../utils/icons";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkBadge } from "../chalk-ui";

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
    colorClass: "text-[var(--chalk-danger)]",
    tone: "danger",
  },
  live: {
    icon: Radio01Icon,
    text: "LIVE",
    colorClass: "text-[var(--chalk-danger)]",
    tone: "danger",
  },
  transcribing: {
    icon: TextIcon,
    text: "CC",
    colorClass: "text-[var(--chalk-accent)]",
    tone: "accent",
  },
  connecting: {
    icon: Alert02Icon,
    text: "CONNECTING...",
    colorClass: "text-[var(--chalk-danger)]",
    tone: "danger",
  },
  reconnecting: {
    icon: Alert02Icon,
    text: "RECONNECTING...",
    colorClass: "text-[var(--chalk-danger)]",
    tone: "danger",
  },
} as const;

export const StatusBadge = React.memo(({ status, pulse = false, size = "md", className }: StatusBadgeProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const { icon: Icon, text, colorClass, tone } = config[status];

  return (
    <ChalkBadge
      className={cn("inline-flex items-center gap-1.5 rounded-none font-medium", size === "sm" ? "min-h-5 px-1.5 py-0.5 text-[10px]" : "min-h-7 px-2 py-1 text-xs", pulse && !prefersReducedMotion && "animate-pulse", colorClass, className)}
      role="status"
      aria-label={status}
      seed={`status-${status}`}
      tone={tone}
    >
      <Icon size={size === "sm" ? 10 : 12} className={cn(status === "recording" && "fill-current")} />
      <span>{text}</span>
    </ChalkBadge>
  );
});

StatusBadge.displayName = "StatusBadge";
