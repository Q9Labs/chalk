import React from 'react';
import { Switch } from '@base-ui/react/switch';
import { cn } from '../../utils/cn';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export const Toggle = React.memo(React.forwardRef<HTMLSpanElement, ToggleProps>(
  ({ checked, onChange, label, disabled = false, size = 'md', className }, ref) => {
    const isSmall = size === 'sm';
    const labelId = React.useId();
    const switchRef = React.useRef<HTMLSpanElement | null>(null);

    const mergedRef = React.useCallback((node: HTMLSpanElement | null) => {
      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        (ref as React.MutableRefObject<HTMLSpanElement | null>).current = node;
      }
      // Keep a local ref for label click-to-toggle behavior.
      switchRef.current = node;
    }, [ref]);

    return (
      <div className={cn('inline-flex items-center gap-2', disabled && 'cursor-not-allowed opacity-50', className)}>
        <Switch.Root
          ref={mergedRef}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-labelledby={label ? labelId : undefined}
          className={cn(
            'relative inline-flex shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            'disabled:cursor-not-allowed',
            isSmall ? 'h-5 w-9' : 'h-6 w-11',
            checked ? 'bg-primary' : 'bg-muted'
          )}
        >
          <Switch.Thumb
            className={cn(
              'pointer-events-none inline-block transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
              isSmall ? 'h-4 w-4' : 'h-5 w-5',
              checked
                ? isSmall ? 'translate-x-4' : 'translate-x-5'
                : 'translate-x-0.5',
              'mt-0.5'
            )}
          />
        </Switch.Root>
        {label && (
          <span
            id={labelId}
            className={cn('text-sm font-medium text-foreground', !disabled && 'cursor-pointer')}
            onClick={() => {
              if (!disabled) {
                switchRef.current?.click();
              }
            }}
          >
            {label}
          </span>
        )}
      </div>
    );
  }
));

Toggle.displayName = 'Toggle';
