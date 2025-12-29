import React, { forwardRef } from 'react';
import { cn } from '../../utils/cn';

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, error, icon, iconPosition = 'left', size = 'md', fullWidth = false, ...props }, ref) => {
    const sizeClasses = {
      sm: 'h-8 text-sm px-2',
      md: 'h-10 text-base px-3',
      lg: 'h-12 text-lg px-4',
    };

    const iconPadding = size === 'sm' ? 'pl-8' : size === 'lg' ? 'pl-10' : 'pl-10';
    const iconPaddingRight = size === 'sm' ? 'pr-8' : size === 'lg' ? 'pr-10' : 'pr-10';

    return (
      <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full')}>
        {label && (
          <label className="text-sm font-medium text-[var(--chalk-text-secondary)]">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && iconPosition === 'left' && (
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--chalk-text-muted)] pointer-events-none">
              {icon}
            </div>
          )}
          
          <input
            ref={ref}
            className={cn(
              'rounded-[var(--chalk-border-radius-md)] border bg-[var(--chalk-bg-secondary)] text-[var(--chalk-text-primary)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--chalk-accent)] focus:border-transparent',
              'placeholder:text-[var(--chalk-text-muted)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'border-[var(--chalk-border-color)]',
              sizeClasses[size],
              fullWidth ? 'w-full' : 'w-auto',
              icon && iconPosition === 'left' && iconPadding,
              icon && iconPosition === 'right' && iconPaddingRight,
              error && 'border-[var(--chalk-danger)] focus:ring-[var(--chalk-danger)]',
              className
            )}
            {...props}
          />

          {icon && iconPosition === 'right' && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--chalk-text-muted)] pointer-events-none">
              {icon}
            </div>
          )}
        </div>
        {error && (
          <span className="text-sm text-[var(--chalk-danger)]">{error}</span>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
