import React from "react";
import { ClassicVolumeSlider } from "./ClassicVolumeSlider";

export interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
  muted?: boolean;
  onMuteToggle?: () => void;
  showValue?: boolean;
  size?: "sm" | "md";
  orientation?: "horizontal" | "vertical";
  className?: string;
}

export const VolumeSlider = React.memo<VolumeSliderProps>((props) => {
  return <ClassicVolumeSlider {...props} />;
});

VolumeSlider.displayName = "VolumeSlider";
