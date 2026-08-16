import React from "react";
import { cn } from "../../utils/cn";
import { ChalkBadge, ChalkChrome } from "../chalk-ui";

export interface ConnectionQualityProps {
  quality: 1 | 2 | 3 | 4;
  showLabel?: boolean;
  size?: "sm" | "md";
  className?: string;
}

const labels = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Excellent",
};

const colors = {
  1: "var(--chalk-danger)",
  2: "var(--chalk-accent)",
  3: "var(--chalk-positive)",
  4: "var(--chalk-positive)",
};

const tones = {
  1: "danger",
  2: "accent",
  3: "success",
  4: "success",
} as const;

export const ConnectionQuality = React.memo(({ quality, showLabel = false, size = "md", className }: ConnectionQualityProps) => {
  const barHeight = size === "sm" ? 10 : 14;
  const barWidth = size === "sm" ? 3 : 4;

  const clampedQuality = quality;
  const color = colors[clampedQuality];

  return (
    <div className={cn("relative inline-flex items-end gap-0.5", className)} title={`Connection Quality: ${labels[clampedQuality]}`} role="status" aria-label={`Connection quality: ${labels[clampedQuality]}`}>
      <ChalkChrome className="pointer-events-none absolute -inset-1 h-[calc(100%+0.5rem)] w-[calc(100%+0.5rem)]" radius={4} roughness={0.8} stroke={color} part="connection-quality" />
      {[1, 2, 3, 4].map((level) => (
        <div
          key={level}
          style={{
            width: barWidth,
            height: (barHeight / 4) * level,
            backgroundColor: level <= clampedQuality ? color : "var(--chalk-stage)",
            borderRadius: "1px",
          }}
        />
      ))}
      {showLabel && (
        <ChalkBadge tone={tones[clampedQuality]} className="ml-1 min-h-0 min-w-0 px-1.5 py-0.5 text-xs">
          {labels[clampedQuality]}
        </ChalkBadge>
      )}
    </div>
  );
});

ConnectionQuality.displayName = "ConnectionQuality";
