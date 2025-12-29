import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface TourHighlightProps {
  targetSelector: string;
  padding?: number;
  borderRadius?: number;
  onClickOutside?: () => void;
  className?: string;
}

export const TourHighlight = React.memo<TourHighlightProps>(({
  targetSelector,
  padding = 4,
  borderRadius = 8,
  onClickOutside,
  className,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const updatePosition = () => {
      const element = document.querySelector(targetSelector);
      if (!element) {
        setRect(null);
        return;
      }

      setRect(element.getBoundingClientRect());
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [targetSelector]);

  useEffect(() => {
    if (!rect || !onClickOutside) return;

    const handleClick = (e: MouseEvent) => {
      const x = e.clientX;
      const y = e.clientY;
      const inside = 
        x >= (rect.left - padding) && 
        x <= (rect.right + padding) && 
        y >= (rect.top - padding) && 
        y <= (rect.bottom + padding);

      if (!inside) {
        e.preventDefault();
        e.stopPropagation();
        onClickOutside();
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [rect, padding, onClickOutside]);

  if (!rect) return null;

  return (
    <div
      className={cn(
        'fixed ease-out pointer-events-none',
        !prefersReducedMotion && 'transition-all duration-300 chalk-animate-highlight',
        'border-2 border-[var(--chalk-accent)]',
        className
      )}
      style={{
        top: rect.top - padding,
        left: rect.left - padding,
        width: rect.width + (padding * 2),
        height: rect.height + (padding * 2),
        borderRadius,
        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.7)',
        zIndex: 9999
      }}
      aria-hidden="true"
    />
  );
});

TourHighlight.displayName = 'TourHighlight';
