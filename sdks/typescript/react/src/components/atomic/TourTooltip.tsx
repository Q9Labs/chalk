import React, { useEffect, useRef } from "react";
import { ArrowRight01Icon, Cancel01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { ChalkButton, ChalkChrome, ChalkIconButton, ChalkPanel } from "../chalk-ui";

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

  const arrowClasses = cn("absolute size-4 rotate-45", {
    "top-[-8px] left-1/2 -translate-x-1/2": placement === "bottom",
    "bottom-[-8px] left-1/2 -translate-x-1/2": placement === "top",
    "left-[-8px] top-1/2 -translate-y-1/2": placement === "right",
    "right-[-8px] top-1/2 -translate-y-1/2": placement === "left",
  });

  return (
    <ChalkPanel ref={tooltipRef} role="dialog" aria-label={title} seed="tour-tooltip" className={cn("relative z-50 min-w-[320px] max-w-sm p-6", "text-[var(--chalk-text)]", !prefersReducedMotion && "chalk-animate-scale-in", className)}>
      <div className={arrowClasses} aria-hidden="true">
        <ChalkChrome className="absolute inset-0 size-full" filled fill="var(--chalk-surface)" radius={2} seed="tour-tooltip-arrow" />
      </div>

      <div className="flex justify-between items-start mb-4">
        <h3 className="font-semibold text-lg leading-tight">{title}</h3>
        {showSkip && (
          <ChalkIconButton type="button" size="sm" seed="tour-skip" onClick={onSkip} className="-mr-1 -mt-1 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Skip tour">
            <Cancel01Icon size={18} />
          </ChalkIconButton>
        )}
      </div>

      <div className="mb-6 text-[var(--chalk-muted-text)] text-[15px] leading-relaxed">{description}</div>

      <div className="flex items-center justify-between gap-4">
        {showProgress ? (
          <div className="flex gap-1.5" aria-label={`Step ${step} of ${totalSteps}`}>
            {Array.from({ length: totalSteps }).map((_, i) => (
              <div key={i} className={cn("w-1.5 h-1.5 rounded-full transition-all duration-300", i + 1 === step ? "bg-[var(--chalk-accent)] w-4" : "bg-[var(--chalk-stage)]")} />
            ))}
          </div>
        ) : (
          <div />
        )}

        <div className="flex gap-2 shrink-0">
          {step > 1 && (
            <ChalkButton type="button" variant="ghost" seed="tour-previous" onClick={onPrev} className="min-h-9 px-3 py-1 text-[var(--chalk-muted-text)] hover:text-[var(--chalk-text)]" aria-label="Previous step">
              Back
            </ChalkButton>
          )}

          <ChalkButton type="button" variant="solid" tone="accent" seed="tour-next" onClick={onNext} className="min-h-9 px-4 py-1 font-bold" aria-label={step === totalSteps ? "Finish tour" : "Next step"}>
            {step === totalSteps ? (
              "Got it"
            ) : (
              <>
                Next <ArrowRight01Icon size={16} className="ml-1.5" />
              </>
            )}
          </ChalkButton>
        </div>
      </div>

      <div className="sr-only">
        Step {step} of {totalSteps}
      </div>
    </ChalkPanel>
  );
});

TourTooltip.displayName = "TourTooltip";
