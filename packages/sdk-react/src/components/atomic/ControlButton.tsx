import React from 'react';
import { cn } from '../../utils/cn';
import { Tooltip } from './Tooltip';

interface ControlButtonProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
  onClick?: () => void;
  className?: string;
  'data-tour'?: string;
}

const sizeClasses = {
  sm: 'h-8 w-8 p-1.5',
  md: 'h-10 w-10 p-2',
  lg: 'h-12 w-12 p-3',
};

export const ControlButton = React.forwardRef<HTMLButtonElement, ControlButtonProps>(
  (
    {
      icon,
      label,
      active = false,
      danger = false,
      disabled = false,
      size = 'md',
      showLabel = false,
      onClick,
      className,
      'data-tour': dataTour,
    },
    ref
  ) => {
    const button = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        disabled={disabled}
        data-tour={dataTour}
        className={cn(
          'group relative flex items-center justify-center rounded-[var(--chalk-border-radius-full)] transition-all duration-200 ease-out hover:scale-105 active:scale-95',
          sizeClasses[size],
          disabled && 'cursor-not-allowed opacity-50 hover:scale-100',
          !disabled && !active && !danger && 'bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] hover:bg-[var(--chalk-bg-secondary)]',
          active && 'bg-[var(--chalk-accent)] text-white shadow-md hover:bg-[var(--chalk-accent-hover)]',
          danger && 'bg-[var(--chalk-danger)] text-white shadow-md hover:bg-red-600',
          className
        )}
        aria-label={label}
        aria-pressed={active}
      >
        {icon}
      </button>
    );

    if (showLabel) {
      return (
        <div className="flex flex-col items-center gap-1">
          {button}
          <span className="text-[var(--chalk-font-size-xs)] text-[var(--chalk-text-secondary)]">
            {label}
          </span>
        </div>
      );
    }

    return (
      <Tooltip content={label} position="top">
        {button}
      </Tooltip>
    );
  }
);

ControlButton.displayName = 'ControlButton';
