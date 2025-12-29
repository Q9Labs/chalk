import React from 'react';
import { cn } from '../../utils/cn';

export interface CaptionLineProps {
  text: string;
  speaker?: string;
  position?: 'top' | 'bottom';
  maxLines?: number;
  className?: string;
}

export const CaptionLine: React.FC<CaptionLineProps> = ({
  text,
  speaker,
  position = 'bottom',
  maxLines = 2,
  className,
}) => {
  if (!text) return null;

  return (
    <div
      className={cn(
        'absolute left-1/2 -translate-x-1/2 z-50 w-full max-w-3xl px-4 text-center pointer-events-none',
        position === 'top' ? 'top-[10%]' : 'bottom-[10%]',
        className
      )}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <div
        className={cn(
          'inline-block px-4 py-2 rounded-[var(--chalk-border-radius-md)]',
          'backdrop-blur-sm transition-all duration-200',
          'text-[var(--chalk-font-size-lg)] text-white font-[var(--chalk-font-weight-medium)]',
          'shadow-[var(--chalk-shadow-md)]'
        )}
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.7)',
        }}
      >
        {speaker && (
          <span className="text-[var(--chalk-accent)] font-bold mr-2">
            {speaker}:
          </span>
        )}
        <span
          className="line-clamp-none"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: maxLines,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {text}
        </span>
      </div>
    </div>
  );
};
