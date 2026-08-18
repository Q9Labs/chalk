import React from "react";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkChrome } from "../chalk-ui";
import { useSkin } from "../skin-context";
import { ClassicWaveform } from "./ClassicWaveform";

export interface WaveformProps {
  levels: number[];
  color?: string;
  animated?: boolean;
  barCount?: number;
  className?: string;
}

export const Waveform = React.memo((props: WaveformProps) => {
  const skin = useSkin();

  return skin === "classic" ? <ClassicWaveform {...props} /> : <ChalkWaveform {...props} />;
});

function ChalkWaveform({ levels, color = "var(--chalk-focus)", animated = true, barCount = 5, className }: WaveformProps) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const displayLevels = React.useMemo(() => {
    if (levels.length === barCount) return levels;

    const result = [];
    const step = levels.length / barCount;
    for (let i = 0; i < barCount; i++) {
      const index = Math.floor(i * step);
      result.push(levels[index] || 0);
    }
    return result;
  }, [levels, barCount]);

  return (
    <div className={cn("relative flex items-center gap-[2px] h-8 px-1", className)} role="img" aria-label="Audio waveform">
      <ChalkChrome className="pointer-events-none absolute inset-0 h-full w-full" radius={5} roughness={0.8} stroke={color} part="waveform" />
      {displayLevels.map((level, i) => (
        <div
          key={i}
          className={cn("w-1 rounded-full bg-current transition-all", animated && !prefersReducedMotion ? "duration-150 ease-out" : "duration-0")}
          style={{
            height: `${Math.max(10, level)}%`,
            backgroundColor: color,
            opacity: 0.8,
          }}
        />
      ))}
    </div>
  );
}

Waveform.displayName = "Waveform";
