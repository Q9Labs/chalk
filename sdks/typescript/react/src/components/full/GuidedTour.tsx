import React, { useState, useEffect, memo } from "react";
import { TourOverlay } from "../composite/TourOverlay";
import type { TourStep } from "../composite/TourOverlay";

export interface GuidedTourProps {
  isOpen: boolean;
  onComplete: () => void;
  onSkip?: () => void;
  steps?: TourStep[];
  showProgress?: boolean;
  showSkip?: boolean;
  className?: string;
}

const DEFAULT_STEPS: TourStep[] = [
  {
    target: '[data-tour="video-grid"]',
    title: "Meeting Stage",
    description: "This is where you'll see everyone's video and shared screens.",
    placement: "bottom",
  },
  {
    target: '[data-tour="controls-mic"]',
    title: "Mute / Unmute",
    description: 'Toggle your microphone on or off. You can also use "M" shortcut.',
    placement: "top",
  },
  {
    target: '[data-tour="controls-video"]',
    title: "Camera",
    description: 'Turn your camera on or off. You can also use "V" shortcut.',
    placement: "top",
  },
  {
    target: '[data-tour="controls-screenshare"]',
    title: "Share Screen",
    description: "Share your entire screen, a window, or a browser tab.",
    placement: "top",
  },
  {
    target: '[data-tour="controls-chat"]',
    title: "Chat",
    description: "Send messages, links, and files to everyone in the meeting.",
    placement: "top",
  },
  {
    target: '[data-tour="controls-participants"]',
    title: "Participants",
    description: "See who is here, manage permissions, and invite others.",
    placement: "top",
  },
  {
    target: '[data-tour="reactions-button"]',
    title: "Reactions",
    description: "Send quick emoji reactions to express yourself without speaking.",
    placement: "top",
  },
  {
    target: '[data-tour="controls-leave"]',
    title: "Leave Meeting",
    description: "Click here when you are ready to end the call or leave.",
    placement: "top",
  },
];

const GuidedTourBase: React.FC<GuidedTourProps> = ({ isOpen, onComplete, onSkip, steps = DEFAULT_STEPS, showProgress = true, showSkip = true, className }) => {
  const [currentStep, setCurrentStep] = useState(1);

  useEffect(() => {
    if (isOpen) {
      setCurrentStep(1);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowRight":
        case "n":
        case "N":
          if (currentStep < steps.length) setCurrentStep((s) => s + 1);
          else onComplete();
          break;
        case "ArrowLeft":
        case "b":
        case "B":
          if (currentStep > 1) setCurrentStep((s) => s - 1);
          break;
        case "Escape":
          onSkip?.();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, currentStep, steps.length, onComplete, onSkip]);

  const handleNext = () => {
    if (currentStep < steps.length) {
      setCurrentStep((s) => s + 1);
    } else {
      onComplete();
    }
  };

  const handlePrev = () => {
    if (currentStep > 1) {
      setCurrentStep((s) => s - 1);
    }
  };

  return <TourOverlay steps={steps} currentStep={currentStep} isOpen={isOpen} onNext={handleNext} onPrev={handlePrev} onSkip={onSkip || onComplete} onComplete={onComplete} showProgress={showProgress} showSkip={showSkip} className={className} />;
};

export const GuidedTour = memo(GuidedTourBase);
GuidedTour.displayName = "GuidedTour";
