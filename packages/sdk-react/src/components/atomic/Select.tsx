import React, { useId, useState, useRef, useEffect } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  label?: string;
  error?: string;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
}

const sizeClasses = {
  sm: 'h-8 text-sm px-2',
  md: 'h-10 text-base px-3',
  lg: 'h-12 text-lg px-4',
};

const iconSizes = {
  sm: 14,
  md: 16,
  lg: 20,
};

export const Select = React.memo(React.forwardRef<HTMLButtonElement, SelectProps>(
  ({ className, options, label, error, size = 'md', fullWidth = false, placeholder, disabled, id, value, onChange }, ref) => {
    const generatedId = useId();
    const selectId = id || generatedId;
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    const selectedOption = options.find(opt => opt.value === value);
    const displayText = selectedOption?.label || placeholder || 'Select...';

    // Close on outside click
    useEffect(() => {
      const handleClickOutside = (event: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
          setIsOpen(false);
        }
      };

      if (isOpen) {
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
      }
    }, [isOpen]);

    // Close on escape
    useEffect(() => {
      const handleEscape = (event: KeyboardEvent) => {
        if (event.key === 'Escape') setIsOpen(false);
      };

      if (isOpen) {
        document.addEventListener('keydown', handleEscape);
        return () => document.removeEventListener('keydown', handleEscape);
      }
    }, [isOpen]);

    const handleSelect = (optionValue: string) => {
      onChange?.({ target: { value: optionValue } });
      setIsOpen(false);
    };

    return (
      <div className={cn('flex flex-col gap-1', fullWidth && 'w-full')} ref={containerRef}>
        {label && (
          <label
            htmlFor={selectId}
            className="text-sm font-medium"
            style={{ color: 'var(--muted-foreground, var(--chalk-text-secondary, #a1a1aa))' }}
          >
            {label}
          </label>
        )}
        <div className="relative">
          <button
            ref={ref}
            id={selectId}
            type="button"
            disabled={disabled}
            onClick={() => !disabled && setIsOpen(!isOpen)}
            className={cn(
              'flex items-center justify-between gap-2 rounded-xl border transition-colors focus:outline-none focus:ring-2 focus:border-transparent',
              'disabled:cursor-not-allowed disabled:opacity-50 whitespace-nowrap',
              sizeClasses[size],
              fullWidth ? 'w-full' : 'w-auto',
              className
            )}
            style={{
              backgroundColor: 'var(--card, var(--chalk-bg-secondary, #1a1a1a))',
              color: selectedOption
                ? 'var(--foreground, var(--chalk-text-primary, #ffffff))'
                : 'var(--muted-foreground, var(--chalk-text-muted, #71717a))',
              borderColor: error
                ? 'var(--destructive, var(--chalk-danger, #ef4444))'
                : 'var(--border, var(--chalk-border-color, rgba(255,255,255,0.1)))',
            }}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
            aria-invalid={!!error}
            aria-errormessage={error ? `${selectId}-error` : undefined}
          >
            <span className="truncate">{displayText}</span>
            <ChevronDown
              size={iconSizes[size]}
              className={cn(
                'shrink-0 transition-transform',
                isOpen && 'rotate-180'
              )}
              style={{ color: 'var(--muted-foreground, var(--chalk-text-muted, #71717a))' }}
            />
          </button>

          {/* Dropdown */}
          {isOpen && (
            <div
              className="absolute z-50 mt-1 w-full rounded-xl border py-1 shadow-lg overflow-hidden"
              role="listbox"
              aria-labelledby={selectId}
              style={{
                backgroundColor: 'var(--popover, var(--card, var(--chalk-bg-secondary, #1a1a1a)))',
                borderColor: 'var(--border, var(--chalk-border-color, rgba(255,255,255,0.1)))',
              }}
            >
              {options.length === 0 ? (
                <div
                  className="px-3 py-2 text-sm"
                  style={{ color: 'var(--muted-foreground, var(--chalk-text-muted, #71717a))' }}
                >
                  No options available
                </div>
              ) : (
                options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={option.value === value}
                    disabled={option.disabled}
                    onClick={() => !option.disabled && handleSelect(option.value)}
                    className={cn(
                      'flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors whitespace-nowrap overflow-hidden',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                    )}
                    style={{
                      backgroundColor: option.value === value
                        ? 'var(--accent, var(--muted, var(--chalk-bg-tertiary, #262626)))'
                        : 'transparent',
                      color: option.value === value
                        ? 'var(--primary, var(--chalk-accent, #6E00E6))'
                        : 'var(--foreground, var(--chalk-text-primary, #ffffff))',
                    }}
                    onMouseEnter={(e) => {
                      if (option.value !== value) {
                        e.currentTarget.style.backgroundColor = 'var(--accent, var(--muted, var(--chalk-bg-tertiary, #262626)))';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (option.value !== value) {
                        e.currentTarget.style.backgroundColor = 'transparent';
                      }
                    }}
                  >
                    <span className="truncate">{option.label}</span>
                    {option.value === value && (
                      <Check
                        size={14}
                        className="shrink-0"
                        style={{ color: 'var(--primary, var(--chalk-accent, #6E00E6))' }}
                      />
                    )}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {error && (
          <span
            id={`${selectId}-error`}
            className="text-sm"
            style={{ color: 'var(--destructive, var(--chalk-danger, #ef4444))' }}
          >
            {error}
          </span>
        )}
      </div>
    );
  }
));

Select.displayName = 'Select';
