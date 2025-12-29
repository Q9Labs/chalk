import React from 'react';
import { cn } from '../../utils/cn';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  variant?: 'text' | 'circular' | 'rectangular' | 'rounded';
  animation?: 'pulse' | 'wave' | 'none';
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({
  width,
  height,
  variant = 'text',
  animation = 'pulse',
  className,
}) => {
  const variantClasses = {
    text: 'rounded-[var(--chalk-border-radius-sm)]',
    circular: 'rounded-full',
    rectangular: 'rounded-none',
    rounded: 'rounded-[var(--chalk-border-radius-md)]',
  };

  const animationClasses = {
    pulse: 'chalk-animate-pulse',
    wave: 'chalk-animate-pulse',
    none: '',
  };

  return (
    <div
      className={cn(
        'bg-[var(--chalk-bg-tertiary)]',
        variantClasses[variant],
        animationClasses[animation],
        className
      )}
      style={{
        width: width ?? (variant === 'text' ? '100%' : undefined),
        height: height ?? (variant === 'text' ? '1em' : undefined),
      }}
      aria-hidden="true"
    />
  );
};
