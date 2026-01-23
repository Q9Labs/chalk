import React from 'react';
import { cn } from '../../utils/cn';

export interface ProgressBarProps {
  value: number;
  max?: number;
  showLabel?: boolean;
  variant?: 'default' | 'success' | 'warning' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  animated?: boolean;
  className?: string;
}

export const ProgressBar = React.memo<ProgressBarProps>(({
  value,
  max = 100,
  showLabel = false,
  variant = 'default',
  size = 'md',
  animated = false,
  className,
}) => {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  const variantColors = {
    default: 'bg-primary',
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-destructive',
  };

  const sizeClasses = {
    sm: 'h-1 text-xs',
    md: 'h-2 text-xs',
    lg: 'h-4 text-sm',
  };

  return (
    <div className={cn('w-full', className)}>
      <div className="flex justify-between mb-1">
        {showLabel && (
          <span className="text-muted-foreground font-medium">
            {Math.round(percentage)}%
          </span>
        )}
      </div>
      <div className={cn('w-full bg-muted rounded-full overflow-hidden', sizeClasses[size])}>
        <div
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={max}
          className={cn(
            'h-full rounded-full transition-all duration-300 ease-in-out',
            variantColors[variant],
            animated && 'chalk-progress-striped'
          )}
          style={{
            width: `${percentage}%`,
            ...(animated ? {
              backgroundImage: 'linear-gradient(45deg,rgba(255,255,255,.15) 25%,transparent 25%,transparent 50%,rgba(255,255,255,.15) 50%,rgba(255,255,255,.15) 75%,transparent 75%,transparent)',
              backgroundSize: '1rem 1rem',
              animation: 'chalk-progress-stripes 1s linear infinite'
            } : {})
          }}
        />
      </div>
      <style>{`
        @keyframes chalk-progress-stripes {
          from { background-position: 1rem 0; }
          to { background-position: 0 0; }
        }
      `}</style>
    </div>
  );
});

ProgressBar.displayName = 'ProgressBar';
