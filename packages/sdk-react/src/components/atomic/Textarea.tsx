import React, { forwardRef, useId } from 'react';
import { cn } from '../../utils/cn';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  maxLength?: number;
  showCount?: boolean;
  resize?: 'none' | 'vertical' | 'horizontal' | 'both';
}

export const Textarea = React.memo(forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, error, maxLength, showCount, resize = 'vertical', value, onChange, id, ...props }, ref) => {
    const generatedId = useId();
    const textareaId = id || generatedId;
    const currentLength = typeof value === 'string' ? value.length : 0;

    return (
      <div className="flex flex-col gap-1.5 w-full">
        {label && (
          <label 
            htmlFor={textareaId}
            className="text-sm font-medium text-[var(--chalk-text-secondary)]"
          >
            {label}
          </label>
        )}
        <textarea
          id={textareaId}
          ref={ref}
          value={value}
          maxLength={maxLength}
          onChange={onChange}
          className={cn(
            'flex min-h-[80px] w-full rounded-[var(--chalk-border-radius-md)] border bg-[var(--chalk-bg-secondary)] px-3 py-2 text-[var(--chalk-font-size-sm)] text-[var(--chalk-text-primary)] transition-colors focus:outline-none focus:ring-2 focus:ring-[var(--chalk-accent)] focus:border-transparent',
            'placeholder:text-[var(--chalk-text-muted)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'border-[var(--chalk-border-color)]',
            resize === 'none' && 'resize-none',
            resize === 'vertical' && 'resize-y',
            resize === 'horizontal' && 'resize-x',
            resize === 'both' && 'resize',
            error && 'border-[var(--chalk-danger)] focus:ring-[var(--chalk-danger)]',
            className
          )}
          aria-invalid={!!error}
          aria-errormessage={error ? `${textareaId}-error` : undefined}
          {...props}
        />
        <div className="flex justify-between items-center text-xs text-[var(--chalk-text-muted)]">
          {error && (
            <span id={`${textareaId}-error`} className="text-[var(--chalk-danger)]">
              {error}
            </span>
          )}
          {!error && <span />}
          {showCount && maxLength && (
            <span>
              {currentLength} / {maxLength}
            </span>
          )}
        </div>
      </div>
    );
  }
));

Textarea.displayName = 'Textarea';
