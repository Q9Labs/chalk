import React, { useEffect, useRef } from "react";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";

export interface TourTooltipProps {
  title: string;
  description: string;
  step: number;
  totalSteps: number;
  placement?: "top" | "bottom" | "left" | "right";
  onNext?: () => void;
  onPrev?: () => void;
  onSkip?: () => void;
  showSkip?: boolean;
  showProgress?: boolean;
  className?: string;
}

export const TourTooltip = React.memo<TourTooltipProps>(({ title, description, step, totalSteps, placement = "bottom", onNext, onPrev, onSkip, showSkip = true, showProgress = true, className }) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "n" || e.key === "N") {
        onNext?.();
      } else if (e.key === "ArrowLeft" || e.key === "b" || e.key === "B") {
        if (step > 1) onPrev?.();
      } else if (e.key === "Escape") {
        onSkip?.();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onNext, onPrev, onSkip, step]);

  const arrowClasses = cn("absolute w-4 h-4 bg-popover rotate-45 border-border", {
    "top-[-8px] left-1/2 -translate-x-1/2 border-t border-l": placement === "bottom",
    "bottom-[-8px] left-1/2 -translate-x-1/2 border-b border-r": placement === "top",
    "left-[-8px] top-1/2 -translate-y-1/2 border-b border-l": placement === "right",
    "right-[-8px] top-1/2 -translate-y-1/2 border-t border-r": placement === "left",
  });

  return (
    <div ref={tooltipRef} role="dialog" aria-label={title} className={cn("relative z-50 min-w-[320px] max-w-sm rounded-lg", "bg-popover border border-border", "shadow-lg p-6", "text-popover-foreground", !prefersReducedMotion && "chalk-animate-scale-in", className)}>
      <div className={arrowClasses} />

      <div className="flex justify-between items-start mb-4">
        <h3 className="font-semibold text-lg">{title}</h3>
        {showSkip && (
          <button onClick={onSkip} className="text-muted-foreground hover:text-foreground transition-colors p-1" aria-label="Skip tour">
            <Cancel01Icon size={16} />
          </button>
        )}
      </div>

      <div className="mb-6 text-muted-foreground text-base leading-relaxed">{description}</div>

      <div className="flex items-center justify-between">
        {showProgress ? (
          <div className="flex gap-1.5" aria-label={`Step ${step} of ${totalSteps}`}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div key={i} className={cn("w-2 h-2 rounded-full transition-colors", i + 1 === step ? "bg-primary" : "bg-muted")} />
            ))}
          </div>
        ) : (
          <div />
        )}

        <div className="flex gap-2">
          {step > 1 && (
            <button onClick={onPrev} className={cn("flex items-center justify-center p-2 rounded-md", "text-muted-foreground hover:bg-muted hover:text-foreground", "transition-colors text-sm")} aria-label="Previous step">
              <ArrowLeft01Icon size={16} className="mr-1" />
              Back
            </button>
          )}

          <button onClick={onNext} className={cn("flex items-center justify-center py-2 px-4 rounded-md", "bg-primary text-primary-foreground hover:bg-primary/90", "transition-colors text-sm font-medium")} aria-label={step === totalSteps ? "Finish tour" : "Next step"}>
            {step === totalSteps ? (
              "Finish"
            ) : (
              <>
                Next <ArrowRight01Icon size={16} className="ml-1" />
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

TourTooltip.displayName = "TourTooltip";
