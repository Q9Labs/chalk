import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
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
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
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
          'flex items-center justify-center rounded-full hover:bg-[var(--chalk-bg-tertiary)] transition-colors',
          size === 'sm' ? 'p-1' : 'p-1.5',
          muted ? 'text-[var(--chalk-text-muted)]' : 'text-[var(--chalk-text-primary)]'
        )}
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted || value === 0 ? (
          <VolumeX size={size === 'sm' ? 14 : 18} />
        ) : (
          <Volume2 size={size === 'sm' ? 14 : 18} />
        )}
      </button>

      <div
        className={cn(
          'relative flex items-center',
          isVertical ? 'h-full w-2 py-2' : 'w-full h-2'
        )}
      >
        <input
          type="range"
          min="0"
          max="100"
          value={muted ? 0 : value}
          onChange={handleChange}
          disabled={muted}
          role="slider"
          aria-valuenow={muted ? 0 : value}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-orientation={orientation}
          className={cn(
            'appearance-none bg-transparent cursor-pointer disabled:cursor-not-allowed',
            isVertical
              ? 'absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90 w-[var(--slider-length)] h-2'
              : 'w-full h-full',
            '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--chalk-accent)] [&::-webkit-slider-thumb]:mt-[-2px] [&::-webkit-slider-thumb]:shadow-sm',
            '[&::-moz-range-thumb]:w-3 [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:border-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--chalk-accent)] [&::-moz-range-thumb]:shadow-sm',
            '[&::-webkit-slider-runnable-track]:w-full [&::-webkit-slider-runnable-track]:h-2 [&::-webkit-slider-runnable-track]:bg-[var(--chalk-bg-tertiary)] [&::-webkit-slider-runnable-track]:rounded-full',
            '[&::-moz-range-track]:w-full [&::-moz-range-track]:h-2 [&::-moz-range-track]:bg-[var(--chalk-bg-tertiary)] [&::-moz-range-track]:rounded-full'
          )}
          style={
            isVertical
              ? ({ '--slider-length': '8rem' } as React.CSSProperties)
              : undefined
          }
        />
      </div>

      {showValue && (
        <span className="text-xs text-[var(--chalk-text-secondary)] min-w-[2rem] text-center">
          {Math.round(value)}%
        </span>
      )}
    </div>
  );
});

VolumeSlider.displayName = 'VolumeSlider';
