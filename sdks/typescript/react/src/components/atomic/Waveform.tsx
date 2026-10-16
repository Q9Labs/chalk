import React from "react";
import { ClassicWaveform } from "./ClassicWaveform";

export interface WaveformProps {
  levels: number[];
  color?: string;
  animated?: boolean;
  barCount?: number;
  className?: string;
}

export const Waveform = React.memo((props: WaveformProps) => {
  return <ClassicWaveform {...props} />;
});

Waveform.displayName = "Waveform";
