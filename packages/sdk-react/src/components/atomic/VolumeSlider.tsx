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
  const handleValueChange = (newValue: number | number[]) => {
    const val = Array.isArray(newValue) ? newValue[0] : newValue;
    if (val !== undefined) {
      onChange(val);
    }
  };

  const isVertical = orientation === 'vertical';

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
        className={cn(
          'flex items-center justify-center rounded-full transition-colors',
          'hover:bg-accent',
          size === 'sm' ? 'p-1' : 'p-1.5',
          muted ? 'text-muted-foreground' : 'text-foreground'
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
        value={muted ? 0 : value}
        onValueChange={handleValueChange}
        disabled={muted}
        min={0}
        max={100}
        step={1}
        orientation={orientation}
        className={cn(
          'relative flex items-center touch-none select-none',
          isVertical ? 'h-full w-2 flex-col' : 'w-full h-2'
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
