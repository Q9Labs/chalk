import React from 'react';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface TranscriptLineProps {
  speaker: string;
  speakerId: string;
  text: string;
  timestamp: Date;
  isInterim?: boolean;
  confidence?: number;
  showTimestamp?: boolean;
  showSpeaker?: boolean;
  speakerColor?: string;
  className?: string;
}

export const TranscriptLine = React.memo<TranscriptLineProps>(({
  speaker,
  speakerId,
  text,
  timestamp,
  isInterim = false,
  confidence = 1.0,
  showTimestamp = true,
  showSpeaker = true,
  speakerColor,
  className,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const timeString = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);

  const opacity = confidence < 0.7 ? 0.6 : 1;

  return (
    <div
      className={cn(
        'py-1 px-2 mb-1 rounded-[var(--chalk-border-radius-sm)]',
        'text-[var(--chalk-font-size-md)] leading-relaxed',
        !prefersReducedMotion && 'chalk-animate-transcript-in transition-all duration-200',
        isInterim ? 'italic text-[var(--chalk-text-muted)]' : 'text-[var(--chalk-text-secondary)]',
        className
      )}
      style={{ opacity }}
      role="listitem"
      aria-live={isInterim ? 'off' : 'polite'}
      data-speaker-id={speakerId}
    >
      {showTimestamp && (
        <span className="text-[var(--chalk-text-muted)] text-[var(--chalk-font-size-sm)] mr-2 select-none">
          [{timeString}]
        </span>
      )}
      
      {showSpeaker && (
        <span
          className="font-[var(--chalk-font-weight-semibold)] mr-2"
          style={{ color: speakerColor || 'var(--chalk-text-primary)' }}
        >
          {speaker}:
        </span>
      )}

      <span className={cn('break-words', isInterim && 'opacity-80')}>
        {text}
      </span>
    </div>
  );
});

TranscriptLine.displayName = 'TranscriptLine';
