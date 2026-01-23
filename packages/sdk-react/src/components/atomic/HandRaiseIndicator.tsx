import React from 'react';
import { HandIcon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

interface HandRaiseIndicatorProps {
  raised: boolean;
  animated?: boolean;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const positionMap = {
  'top-left': 'top-2 left-2',
  'top-right': 'top-2 right-2',
  'bottom-left': 'bottom-2 left-2',
  'bottom-right': 'bottom-2 right-2',
};

const sizeMap = {
  sm: 20,
  md: 24,
  lg: 32,
};

export const HandRaiseIndicator = React.memo(({
  raised,
  animated = true,
  position = 'top-right',
  size = 'md',
  className,
}: HandRaiseIndicatorProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();

  if (!raised) return null;

  return (
    <div
      className={cn(
        'absolute z-10 flex items-center justify-center rounded-full bg-warning p-1.5 text-white shadow-md',
        positionMap[position],
        !prefersReducedMotion && 'chalk-animate-scale-in',
        animated && !prefersReducedMotion && 'chalk-animate-hand-bounce',
        className
      )}
      role="status"
      aria-label="Hand raised"
    >
      <HandIcon size={sizeMap[size]} fill="currentColor" />
    </div>
  );
});

HandRaiseIndicator.displayName = 'HandRaiseIndicator';
