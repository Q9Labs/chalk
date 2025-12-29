import React from 'react';
import { Mic, MicOff } from 'lucide-react';
import { cn } from '../../utils/cn';

interface AudioIndicatorProps {
  level?: number;
  muted?: boolean;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'bars' | 'icon' | 'dot';
  className?: string;
}

const sizeMap = {
  sm: { width: 16, height: 16 },
  md: { width: 20, height: 20 },
  lg: { width: 24, height: 24 },
};

export const AudioIndicator = React.memo(({
  level = 0,
  muted = false,
  size = 'md',
  variant = 'icon',
  className,
}: AudioIndicatorProps) => {
  const { width, height } = sizeMap[size];

  if (variant === 'dot') {
    return (
      <div
        className={cn(
          'rounded-full transition-colors duration-200',
          muted
            ? 'bg-[var(--chalk-text-muted)]'
            : level > 10
            ? 'bg-[var(--chalk-success)]'
            : 'bg-[var(--chalk-bg-tertiary)]',
          className
        )}
        style={{ width: width / 2, height: width / 2 }}
        role="status"
        aria-label={muted ? 'Microphone muted' : `Microphone active, level ${level}%`}
      />
    );
  }

  if (variant === 'bars') {
    return (
      <div
        className={cn('flex items-end justify-center gap-[2px]', className)}
        style={{ width, height }}
        role="status"
        aria-label={muted ? 'Microphone muted' : `Microphone active, level ${level}%`}
      >
        {[0.6, 1, 0.6].map((scale, i) => {
          const barLevel = Math.max(0, Math.min(100, level * scale));
          const h = muted ? 20 : Math.max(20, barLevel);
          
          return (
            <div
              key={i}
              className={cn(
                'w-[3px] rounded-[1px] transition-all duration-100 ease-out',
                muted ? 'bg-[var(--chalk-text-muted)]' : 'bg-[var(--chalk-success)]'
              )}
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

  const Icon = muted ? MicOff : Mic;
  return (
    <div
      className={cn(
        'flex items-center justify-center transition-colors',
        muted ? 'text-[var(--chalk-danger)]' : 'text-[var(--chalk-text-primary)]',
        className
      )}
      role="status"
      aria-label={muted ? 'Microphone muted' : 'Microphone active'}
    >
      <Icon size={width} />
      {!muted && level > 10 && (
        <div
          className="absolute inset-0 rounded-full bg-[var(--chalk-success)] opacity-20"
          style={{
            transform: `scale(${1 + level / 200})`,
            transition: 'transform 0.1s ease-out',
          }}
        />
      )}
    </div>
  );
});

AudioIndicator.displayName = 'AudioIndicator';
