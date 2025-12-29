import React from 'react';
import { cn } from '../../utils/cn';

interface IconButtonProps {
  icon: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'ghost' | 'outline';
  onClick?: () => void;
  disabled?: boolean;
  'aria-label': string;
  className?: string;
}

const sizeClasses = {
  sm: 'h-8 w-8 p-1.5',
  md: 'h-10 w-10 p-2',
  lg: 'h-12 w-12 p-3',
};

const variantClasses = {
  default: 'bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] hover:bg-[var(--chalk-bg-secondary)] shadow-sm',
  ghost: 'bg-transparent text-[var(--chalk-text-secondary)] hover:bg-[var(--chalk-bg-tertiary)] hover:text-[var(--chalk-text-primary)]',
  outline: 'border border-[var(--chalk-border-color)] bg-transparent text-[var(--chalk-text-primary)] hover:bg-[var(--chalk-bg-tertiary)]',
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      size = 'md',
      variant = 'default',
      onClick,
      disabled = false,
      'aria-label': ariaLabel,
      className,
    },
    ref
  ) => {
    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'inline-flex items-center justify-center rounded-[var(--chalk-border-radius-md)] transition-colors duration-200',
          sizeClasses[size],
          variantClasses[variant],
          disabled && 'cursor-not-allowed opacity-50',
          className
        )}
        aria-label={ariaLabel}
      >
        {icon}
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';
