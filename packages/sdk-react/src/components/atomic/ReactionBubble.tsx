import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';

interface ReactionBubbleProps {
  emoji: string;
  onComplete?: () => void;
  duration?: number;
  className?: string;
}

export const ReactionBubble = React.memo(({
  emoji,
  onComplete,
  duration = 2000,
  className,
}: ReactionBubbleProps) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      onComplete?.();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onComplete]);

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 right-4 z-50 text-4xl',
        'chalk-animate-float-up',
        className
      )}
      role="presentation"
      aria-hidden="true"
    >
      {emoji}
    </div>
  );
});

ReactionBubble.displayName = 'ReactionBubble';
