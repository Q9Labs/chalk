import React from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  color?: string;
  className?: string;
}

export const Spinner = React.memo<SpinnerProps>(({
  size = 'md',
  color = 'var(--chalk-accent)',
  className,
}) => {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-6 h-6',
    lg: 'w-8 h-8',
    xl: 'w-12 h-12',
  };

  return (
    <Loader2
      className={cn('animate-spin', sizeClasses[size], className)}
      style={{ color }}
      role="status"
      aria-label="Loading"
    />
  );
});

Spinner.displayName = 'Spinner';
