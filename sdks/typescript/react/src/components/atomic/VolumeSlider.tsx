import React from "react";
import { VolumeHighIcon, VolumeMute01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { ChalkIconButton, ChalkSlider } from "../chalk-ui";
import { useSkin } from "../skin-context";
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
  const skin = useSkin();

  return skin === "classic" ? <ClassicVolumeSlider {...props} /> : <ChalkVolumeSlider {...props} />;
});

function ChalkVolumeSlider({ value, onChange, muted = false, onMuteToggle, showValue = false, size = "md", orientation = "horizontal", className }: VolumeSliderProps) {
  const isVertical = orientation === "vertical";
  const sliderValue = muted ? 0 : value;

  return (
    <div className={cn("flex items-center gap-2", isVertical ? "flex-col-reverse h-32 w-8" : "flex-row w-full", className)}>
      <ChalkIconButton
        onClick={onMuteToggle}
        disabled={!onMuteToggle}
        size={size === "sm" ? "sm" : "md"}
        className={cn("!size-auto rounded-full transition-colors", "hover:bg-[var(--chalk-stage)]", size === "sm" ? "p-1" : "p-1.5", muted ? "text-[var(--chalk-muted-text)]" : "text-[var(--chalk-text)]", !onMuteToggle && "pointer-events-none opacity-50")}
        aria-label={muted ? "Unmute volume" : "Mute volume"}
      >
        {muted || value === 0 ? <VolumeMute01Icon size={size === "sm" ? 14 : 18} /> : <VolumeHighIcon size={size === "sm" ? 14 : 18} />}
      </ChalkIconButton>

      <ChalkSlider
        aria-label="Volume"
        value={sliderValue}
        min={0}
        max={100}
        step={1}
        orientation={orientation}
        wrapperClassName={cn("relative flex items-center", isVertical ? "h-full w-2 flex-col" : "w-full")}
        className={cn("size-full", isVertical ? "h-full w-2" : "h-5 w-full")}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />

      {showValue && <span className="text-xs text-[var(--chalk-muted-text)] min-w-[2rem] text-center">{Math.round(sliderValue)}%</span>}
    </div>
  );
}

VolumeSlider.displayName = "VolumeSlider";
