import React, { useState, useRef, useEffect } from 'react';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  position?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  className?: string;
}

export const Tooltip = React.memo(({
  content,
  children,
  position = 'top',
  delay = 200,
  className,
}: TooltipProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [isVisible, setIsVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = () => {
    timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
  };

  const hide = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setIsVisible(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const positionClasses = {
    top: 'bottom-full left-1/2 mb-6 -translate-x-1/2',
    bottom: 'top-full left-1/2 mt-6 -translate-x-1/2',
    left: 'right-full top-1/2 mr-6 -translate-y-1/2',
    right: 'left-full top-1/2 ml-6 -translate-y-1/2',
  };

  return (
    <div 
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {isVisible && (
        <div
          className={cn(
            'absolute z-[100] pointer-events-none whitespace-nowrap rounded-[var(--chalk-border-radius-sm)] bg-[var(--chalk-bg-primary)] px-2 py-1 text-[var(--chalk-font-size-xs)] text-[var(--chalk-text-primary)] shadow-md ring-1 ring-[var(--chalk-border-color)]',
            !prefersReducedMotion && 'chalk-animate-scale-in origin-center',
            positionClasses[position],
            className
          )}
          role="tooltip"
        >
          {content}
          <div
            className={cn(
              'absolute h-2 w-2 rotate-45 border-r border-b border-[var(--chalk-border-color)] bg-[var(--chalk-bg-primary)]',
              position === 'top' && 'bottom-[-5px] left-1/2 -translate-x-1/2 rotate-45 border-l-0 border-t-0',
              position === 'bottom' && 'top-[-5px] left-1/2 -translate-x-1/2 -rotate-135 border-l-0 border-t-0',
              position === 'left' && 'right-[-5px] top-1/2 -translate-y-1/2 -rotate-45 border-l-0 border-t-0',
              position === 'right' && 'left-[-5px] top-1/2 -translate-y-1/2 rotate-135 border-l-0 border-t-0'
            )}
          />
        </div>
      )}
    </div>
  );
});

Tooltip.displayName = 'Tooltip';
