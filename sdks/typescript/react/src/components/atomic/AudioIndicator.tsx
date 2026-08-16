import React from "react";
import { Microphone01Icon, MicrophoneOff01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { ChalkBadge, ChalkChrome } from "../chalk-ui";

interface AudioIndicatorProps {
  level?: number;
  muted?: boolean;
  size?: "sm" | "md" | "lg";
  variant?: "bars" | "icon" | "dot";
  className?: string;
}

const sizeMap = {
  sm: { width: 16, height: 16 },
  md: { width: 20, height: 20 },
  lg: { width: 24, height: 24 },
};

export const AudioIndicator = React.memo(({ level = 0, muted = false, size = "md", variant = "icon", className }: AudioIndicatorProps) => {
  const { width, height } = sizeMap[size];
  const clampedLevel = Math.max(0, Math.min(100, level));

  if (variant === "dot") {
    return (
      <ChalkBadge
        dot
        tone={muted ? "neutral" : clampedLevel > 10 ? "success" : "neutral"}
        className={cn("transition-colors duration-200", className)}
        style={{ width: width / 2, height: width / 2 }}
        role="status"
        aria-label={muted ? "Microphone muted" : `Microphone active, level ${Math.round(clampedLevel)}%`}
      />
    );
  }

  if (variant === "bars") {
    return (
      <div className={cn("relative flex items-end justify-center gap-[2px]", className)} style={{ width, height }} role="status" aria-label={muted ? "Microphone muted" : `Microphone active, level ${Math.round(clampedLevel)}%`}>
        <ChalkChrome className="pointer-events-none absolute inset-0 h-full w-full" radius={4} roughness={0.8} stroke={muted ? "var(--chalk-muted-text)" : "var(--chalk-positive)"} part="audio-bars" />
        {[0.6, 1, 0.6].map((scale, i) => {
          const barLevel = Math.max(0, Math.min(100, clampedLevel * scale));
          const h = muted ? 20 : Math.max(20, barLevel);

          return (
            <div
              key={i}
              className={cn("w-[3px] rounded-[1px] transition-all duration-100 ease-out", muted ? "bg-[var(--chalk-muted-text)]" : "bg-[var(--chalk-positive)]")}
              style={{
                height: `${h}%`,
                opacity: muted ? 0.5 : 1,
              }}
            />
          );
        })}
      </div>
    );
  }

  const Icon = muted ? MicrophoneOff01Icon : Microphone01Icon;
  return (
    <div className={cn("relative flex items-center justify-center transition-colors", muted ? "text-[var(--chalk-danger)]" : "text-[var(--chalk-text)]", className)} role="status" aria-label={muted ? "Microphone muted" : "Microphone active"}>
      <ChalkChrome className="pointer-events-none absolute inset-0 h-full w-full" shape="circle" radius={999} roughness={0.8} stroke={muted ? "var(--chalk-danger)" : "var(--chalk-app-line-strong, currentColor)"} part="audio-icon" />
      <Icon className="relative z-[1]" size={width} />
      {!muted && clampedLevel > 10 && (
        <div
          className="absolute inset-0 rounded-full bg-[var(--chalk-positive)] opacity-20"
          style={{
            transform: `scale(${1 + clampedLevel / 200})`,
            transition: "transform 0.1s ease-out",
          }}
        />
      )}
    </div>
  );
});

AudioIndicator.displayName = "AudioIndicator";
