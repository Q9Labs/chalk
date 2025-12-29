import React, { useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface TourTooltipProps {
  title: string;
  description: string;
  step: number;
  totalSteps: number;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  showSkip?: boolean;
  showProgress?: boolean;
  className?: string;
}

export const TourTooltip = React.memo<TourTooltipProps>(({
  title,
  description,
  step,
  totalSteps,
  placement = 'bottom',
  onNext,
  onPrev,
  onSkip,
  showSkip = true,
  showProgress = true,
  className,
}) => {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'n' || e.key === 'N') {
        onNext?.();
      } else if (e.key === 'ArrowLeft' || e.key === 'b' || e.key === 'B') {
        if (step > 1) onPrev?.();
      } else if (e.key === 'Escape') {
        onSkip?.();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onNext, onPrev, onSkip, step]);

  const arrowClasses = cn(
    'absolute w-4 h-4 bg-[var(--chalk-bg-secondary)] rotate-45 border-[var(--chalk-border-color)]',
    {
      'top-[-8px] left-1/2 -translate-x-1/2 border-t border-l': placement === 'bottom',
      'bottom-[-8px] left-1/2 -translate-x-1/2 border-b border-r': placement === 'top',
      'left-[-8px] top-1/2 -translate-y-1/2 border-b border-l': placement === 'right',
      'right-[-8px] top-1/2 -translate-y-1/2 border-t border-r': placement === 'left',
    }
  );

  return (
    <div
      ref={tooltipRef}
      role="dialog"
      aria-label={title}
      className={cn(
        'relative z-50 min-w-[320px] max-w-sm rounded-[var(--chalk-border-radius-lg)]',
        'bg-[var(--chalk-bg-secondary)] border border-[var(--chalk-border-color)]',
        'shadow-[var(--chalk-shadow-lg)] p-[var(--chalk-spacing-lg)]',
        'text-[var(--chalk-text-primary)] chalk-animate-scale-in',
        className
      )}
    >
      <div className={arrowClasses} />

      <div className="flex justify-between items-start mb-[var(--chalk-spacing-md)]">
        <h3 className="font-[var(--chalk-font-weight-semibold)] text-[var(--chalk-font-size-lg)]">
          {title}
        </h3>
        {showSkip && (
          <button
            onClick={onSkip}
            className="text-[var(--chalk-text-muted)] hover:text-[var(--chalk-text-primary)] transition-colors p-1"
            aria-label="Skip tour"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="mb-[var(--chalk-spacing-lg)] text-[var(--chalk-text-secondary)] text-[var(--chalk-font-size-md)] leading-relaxed">
        {description}
      </div>

      <div className="flex items-center justify-between">
        {showProgress ? (
          <div className="flex gap-1.5" aria-label={`Step ${step} of ${totalSteps}`}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  'w-2 h-2 rounded-full transition-colors',
                  i + 1 === step
                    ? 'bg-[var(--chalk-accent)]'
                    : 'bg-[var(--chalk-bg-tertiary)]'
                )}
              />
            ))}
          </div>
        ) : (
          <div />
        )}

        <div className="flex gap-[var(--chalk-spacing-sm)]">
          {step > 1 && (
            <button
              onClick={onPrev}
              className={cn(
                'flex items-center justify-center p-[var(--chalk-spacing-sm)] rounded-[var(--chalk-border-radius-md)]',
                'text-[var(--chalk-text-secondary)] hover:bg-[var(--chalk-bg-tertiary)] hover:text-[var(--chalk-text-primary)]',
                'transition-colors text-[var(--chalk-font-size-sm)]'
              )}
              aria-label="Previous step"
            >
              <ChevronLeft size={16} className="mr-1" />
              Back
            </button>
          )}

          <button
            onClick={onNext}
            className={cn(
              'flex items-center justify-center py-[var(--chalk-spacing-sm)] px-[var(--chalk-spacing-md)] rounded-[var(--chalk-border-radius-md)]',
              'bg-[var(--chalk-accent)] text-white hover:bg-[var(--chalk-accent-hover)]',
              'transition-colors text-[var(--chalk-font-size-sm)] font-[var(--chalk-font-weight-medium)]'
            )}
            aria-label={step === totalSteps ? 'Finish tour' : 'Next step'}
          >
            {step === totalSteps ? (
              'Finish'
            ) : (
              <>
                Next <ChevronRight size={16} className="ml-1" />
              </>
            )}
          </button>
        </div>
      </div>
      
      <div className="sr-only">
        Step {step} of {totalSteps}
      </div>
    </div>
  );
});

TourTooltip.displayName = 'TourTooltip';
