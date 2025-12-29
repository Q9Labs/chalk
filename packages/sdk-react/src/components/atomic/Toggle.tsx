import React from 'react';
import { cn } from '../../utils/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export const Toggle = React.forwardRef<HTMLButtonElement, ToggleProps>(
  ({ checked, onChange, label, disabled = false, size = 'md', className }, ref) => {
    const handleKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onChange(!checked);
      }
    };

    const isSmall = size === 'sm';

    return (
      <label className={cn('inline-flex items-center gap-2', disabled && 'cursor-not-allowed opacity-50', className)}>
        <button
          ref={ref}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          onKeyDown={handleKeyDown}
          className={cn(
            'relative inline-flex shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-accent)] focus-visible:ring-offset-2',
            isSmall ? 'h-5 w-9' : 'h-6 w-11',
            checked ? 'bg-[var(--chalk-accent)]' : 'bg-[var(--chalk-bg-tertiary)]'
          )}
        >
          <span className="sr-only">{label || 'Toggle'}</span>
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none inline-block transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
              isSmall ? 'h-4 w-4' : 'h-5 w-5',
              checked
                ? isSmall ? 'translate-x-4' : 'translate-x-5'
                : 'translate-x-0'
            )}
          />
        </button>
        {label && (
          <span className="text-[var(--chalk-font-size-sm)] font-medium text-[var(--chalk-text-primary)]">
            {label}
          </span>
        )}
      </label>
    );
  }
);

Toggle.displayName = 'Toggle';
