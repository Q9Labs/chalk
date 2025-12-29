import React, { useEffect, useState } from 'react';
import { cn } from '../../utils/cn';
import { TourHighlight } from '../atomic/TourHighlight';
import { TourTooltip } from '../atomic/TourTooltip';

export interface TourStep {
  target: string;
  title: string;
  description: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

export interface TourOverlayProps {
  steps: TourStep[];
  currentStep: number;
  isOpen: boolean;
  onNext: () => void;
  onPrev: () => void;
  onSkip: () => void;
  onComplete: () => void;
  showProgress?: boolean;
  showSkip?: boolean;
  backdropOpacity?: number;
  className?: string;
}

export const TourOverlay = React.memo<TourOverlayProps>(({
  steps,
  currentStep,
  isOpen,
  onNext,
  onPrev,
  onSkip,
  onComplete,
  showProgress = true,
  showSkip = true,
  backdropOpacity = 0.5,
  className,
}) => {
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const stepData = steps[currentStep - 1];

  useEffect(() => {
    if (!isOpen || !stepData) {
      setTargetRect(null);
      return;
    }

    const updatePosition = () => {
      const element = document.querySelector(stepData.target);
      if (element) {
        setTargetRect(element.getBoundingClientRect());
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        setTargetRect(null);
      }
    };

    updatePosition();
    
    const raf = requestAnimationFrame(updatePosition);
    
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, stepData]);

  if (!isOpen || !stepData) return null;

  const getTooltipStyle = () => {
    if (!targetRect) return {};

    const spacing = 12;
    const placement = stepData.placement || 'bottom';

    let top = 0;
    let left = 0;

    switch (placement) {
      case 'bottom':
        top = targetRect.bottom + spacing;
        left = targetRect.left + (targetRect.width / 2);
        break;
      case 'top':
        top = targetRect.top - spacing;
        left = targetRect.left + (targetRect.width / 2);
        break;
      case 'right':
        top = targetRect.top + (targetRect.height / 2);
        left = targetRect.right + spacing;
        break;
      case 'left':
        top = targetRect.top + (targetRect.height / 2);
        left = targetRect.left - spacing;
        break;
    }

    return {
      top,
      left,
    };
  };

  const tooltipStyle = getTooltipStyle();
  const placement = stepData.placement || 'bottom';

  const transformClass = {
    'bottom': '-translate-x-1/2',
    'top': '-translate-x-1/2 -translate-y-full',
    'right': '-translate-y-1/2',
    'left': '-translate-x-full -translate-y-1/2',
  }[placement];

  return (
    <div className={cn('fixed inset-0 z-[9999] pointer-events-none', className)}>
      <div 
        className="absolute inset-0 bg-black transition-opacity duration-300"
        style={{ opacity: backdropOpacity }}
      />

      <TourHighlight 
        targetSelector={stepData.target}
        onClickOutside={onSkip}
        padding={8}
      />

      {targetRect && (
        <div 
          className={cn('absolute pointer-events-auto transition-all duration-300 ease-out', transformClass)}
          style={tooltipStyle}
        >
          <TourTooltip
            title={stepData.title}
            description={stepData.description}
            step={currentStep}
            totalSteps={steps.length}
            placement={placement}
            onNext={currentStep === steps.length ? onComplete : onNext}
            onPrev={onPrev}
            onSkip={onSkip}
            showSkip={showSkip}
            showProgress={showProgress}
          />
        </div>
      )}
    </div>
  );
});

TourOverlay.displayName = 'TourOverlay';
