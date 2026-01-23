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
            className="text-sm font-medium text-muted-foreground"
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
            'flex min-h-[80px] w-full rounded-md border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors',
            'focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent',
            'placeholder:text-muted-foreground',
            'disabled:cursor-not-allowed disabled:opacity-50',
            resize === 'none' && 'resize-none',
            resize === 'vertical' && 'resize-y',
            resize === 'horizontal' && 'resize-x',
            resize === 'both' && 'resize',
            error && 'border-destructive focus:ring-destructive',
            className
          )}
          aria-invalid={!!error}
          aria-errormessage={error ? `${textareaId}-error` : undefined}
          {...props}
        />
        <div className="flex justify-between items-center text-xs text-muted-foreground">
          {error && (
            <span id={`${textareaId}-error`} className="text-destructive">
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
