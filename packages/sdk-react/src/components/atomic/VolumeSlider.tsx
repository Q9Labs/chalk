import React from 'react';
import { Slider } from '@base-ui/react/slider';
import { VolumeHighIcon, VolumeMute01Icon } from '../../utils/icons';
import { cn } from '../../utils/cn';

export interface VolumeSliderProps {
  value: number;
  onChange: (value: number) => void;
  muted?: boolean;
  onMuteToggle?: () => void;
  showValue?: boolean;
  size?: 'sm' | 'md';
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

export const VolumeSlider = React.memo<VolumeSliderProps>(({
  value,
  onChange,
  muted = false,
  onMuteToggle,
  showValue = false,
  size = 'md',
  orientation = 'horizontal',
  className,
}) => {
  const handleValueChange = (newValue: number[]) => {
    const val = newValue[0];
    if (val !== undefined) onChange(val);
  };

  const isVertical = orientation === 'vertical';
  const sliderValue = muted ? 0 : value;

  return (
    <div
      className={cn(
        'flex items-center gap-2',
        isVertical ? 'flex-col-reverse h-32 w-8' : 'flex-row w-full',
        className
      )}
    >
      <button
        type="button"
        onClick={onMuteToggle}
        disabled={!onMuteToggle}
        className={cn(
          'flex items-center justify-center rounded-full transition-colors',
          'hover:bg-accent',
          size === 'sm' ? 'p-1' : 'p-1.5',
          muted ? 'text-muted-foreground' : 'text-foreground',
          !onMuteToggle && 'opacity-50 pointer-events-none'
        )}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted || value === 0 ? (
          <VolumeMute01Icon size={size === 'sm' ? 14 : 18} />
        ) : (
          <VolumeHighIcon size={size === 'sm' ? 14 : 18} />
        )}
      </button>

      <Slider.Root
        value={[sliderValue]}
        onValueChange={handleValueChange}
        min={0}
        max={100}
        step={1}
        orientation={orientation}
        className={cn(
          'relative flex items-center',
          isVertical ? 'h-full w-2 flex-col' : 'w-full'
        )}
      >
        <Slider.Control
          className={cn(
            'relative flex items-center touch-none select-none cursor-pointer',
            isVertical ? 'h-full w-2 flex-col' : 'w-full h-5'
          )}
        >
          <Slider.Track
            className={cn(
              'relative grow rounded-full bg-muted',
              isVertical ? 'w-2 h-full' : 'h-2 w-full'
            )}
          >
            <Slider.Indicator
              className={cn(
                'absolute rounded-full bg-primary',
                isVertical ? 'w-full bottom-0' : 'h-full left-0'
              )}
            />
            <Slider.Thumb
              className={cn(
                'block rounded-full shadow-sm bg-primary',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:pointer-events-none disabled:opacity-50',
                size === 'sm' ? 'h-3 w-3' : 'h-4 w-4'
              )}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>

      {showValue && (
        <span className="text-xs text-muted-foreground min-w-[2rem] text-center">
          {Math.round(value)}%
        </span>
      )}
    </div>
  );
});

VolumeSlider.displayName = 'VolumeSlider';
