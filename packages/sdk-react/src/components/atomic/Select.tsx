import React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: SelectOption[];
  label?: string;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  placeholder?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, options, label, error, size = 'md', fullWidth = false, placeholder, disabled, ...props }, ref) => {
    const sizeClasses = {
      sm: 'h-8 text-sm pl-2 pr-8',
      md: 'h-10 text-base pl-3 pr-10',
      lg: 'h-12 text-lg pl-4 pr-12',
    };

    return (
      <div className={cn('flex flex-col gap-1.5', fullWidth && 'w-full')}>
        {label && (
          <label className="text-sm font-medium text-[var(--chalk-text-secondary)]">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            ref={ref}
            disabled={disabled}
            className={cn(
              'appearance-none rounded-[var(--chalk-border-radius-md)] border bg-[var(--chalk-bg-secondary)] text-[var(--chalk-text-primary)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--chalk-accent)] focus:border-transparent',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'border-[var(--chalk-border-color)]',
              sizeClasses[size],
              fullWidth ? 'w-full' : 'w-auto',
              error && 'border-[var(--chalk-danger)] focus:ring-[var(--chalk-danger)]',
              className
            )}
            {...props}
          >
            {placeholder && (
              <option value="" disabled selected>
                {placeholder}
              </option>
            )}
            {options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--chalk-text-muted)]">
            <ChevronDown size={size === 'sm' ? 14 : size === 'lg' ? 20 : 16} />
          </div>
        </div>
        {error && (
          <span className="text-sm text-[var(--chalk-danger)]">{error}</span>
        )}
      </div>
    );
  }
);

Select.displayName = 'Select';
