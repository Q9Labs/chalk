import React from 'react';
import type { ChalkHapticInput } from "../../hooks/ui/useHaptics";
import { useHaptics } from "../../hooks/ui/useHaptics";
import { cn } from '../../utils/cn';

interface IconButtonProps {
  icon: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'ghost' | 'outline';
  onClick?: () => void;
  disabled?: boolean;
  haptic?: ChalkHapticInput | false;
  'aria-label': string;
  className?: string;
}

const sizeClasses = {
  sm: 'h-8 w-8 p-1.5',
  md: 'h-10 w-10 p-2',
  lg: 'h-12 w-12 p-3',
};

const variantClasses = {
  default: 'bg-secondary text-foreground hover:bg-accent shadow-sm',
  ghost: 'bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
  outline: 'border border-border bg-transparent text-foreground hover:bg-accent',
};

export const IconButton = React.memo(React.forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    {
      icon,
      size = 'md',
      variant = 'default',
      onClick,
      disabled = false,
      haptic = "selection",
      'aria-label': ariaLabel,
      className,
    },
    ref
  ) => {
    const { trigger } = useHaptics({
      enabled: !disabled && haptic !== false,
    });

    const handleClick = React.useCallback(() => {
      if (haptic !== false) {
        void trigger(haptic);
      }

      onClick?.();
    }, [haptic, onClick, trigger]);

    return (
      <button
        ref={ref}
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className={cn(
          'inline-flex items-center justify-center rounded-md transition-colors duration-200',
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
));

IconButton.displayName = 'IconButton';
