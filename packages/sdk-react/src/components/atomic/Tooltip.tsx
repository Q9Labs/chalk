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
    top: 'bottom-full left-1/2 mb-24 -translate-x-1/2',
    bottom: 'top-full left-1/2 mt-24 -translate-x-1/2',
    left: 'right-full top-1/2 mr-24 -translate-y-1/2',
    right: 'left-full top-1/2 ml-24 -translate-y-1/2',
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
            'absolute z-[1000] pointer-events-none whitespace-nowrap rounded-lg bg-[#1A1625] px-3 py-1.5 text-xs font-medium text-white shadow-xl ring-1 ring-white/10',
            !prefersReducedMotion && 'animate-in fade-in zoom-in-95 duration-200',
            positionClasses[position],
            className
          )}
          role="tooltip"
        >
          {content}
          <div
            className={cn(
              'absolute h-2 w-2 rotate-45 border-r border-b border-white/10 bg-[#1A1625]',
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
