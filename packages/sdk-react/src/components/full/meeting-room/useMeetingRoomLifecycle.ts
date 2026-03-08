import { useCallback, useEffect, useRef } from "react";

import { useHaptics } from "../../../hooks/ui/useHaptics";

interface UseMeetingRoomLifecycleOptions {
  enableTour: boolean;
  showTourOnFirstVisit: boolean;
  defaultChatOpen: boolean;
  onChatOpen?: () => void;
  onToggleMute?: () => void;
  onToggleVideo?: () => void;
  onLeave?: () => void;
  onTourComplete?: () => void;
  setShowTour: (show: boolean) => void;
  setIsExiting: (exiting: boolean) => void;
}

const LEAVE_ANIMATION_MS = 600;

export function useMeetingRoomLifecycle({ enableTour, showTourOnFirstVisit, defaultChatOpen, onChatOpen, onToggleMute, onToggleVideo, onLeave, onTourComplete, setShowTour, setIsExiting }: UseMeetingRoomLifecycleOptions) {
  const leaveTimeoutRef = useRef<number | null>(null);
  const hasMarkedDefaultChatReadRef = useRef(false);
  const { trigger } = useHaptics();

  const clearLeaveTimeout = useCallback(() => {
    if (leaveTimeoutRef.current !== null) {
      window.clearTimeout(leaveTimeoutRef.current);
      leaveTimeoutRef.current = null;
    }
  }, []);

  const handleLeave = useCallback(() => {
    setIsExiting(true);
    clearLeaveTimeout();
    leaveTimeoutRef.current = window.setTimeout(() => {
      onLeave?.();
      setIsExiting(false);
      leaveTimeoutRef.current = null;
    }, LEAVE_ANIMATION_MS);
  }, [clearLeaveTimeout, onLeave, setIsExiting]);

  const handleTourComplete = useCallback(() => {
    setShowTour(false);
    localStorage.setItem("chalk-tour-completed", "true");
    onTourComplete?.();
  }, [onTourComplete, setShowTour]);

  const handleCopyLink = useCallback(() => {
    const meetingLink = window.location.href;
    navigator.clipboard.writeText(meetingLink);
  }, []);

  useEffect(() => {
    if (!enableTour || !showTourOnFirstVisit) {
      return;
    }
    const hasSeenTour = localStorage.getItem("chalk-tour-completed");
    if (!hasSeenTour) {
      setShowTour(true);
    }
  }, [enableTour, setShowTour, showTourOnFirstVisit]);

  useEffect(() => {
    if (!defaultChatOpen || hasMarkedDefaultChatReadRef.current) return;
    hasMarkedDefaultChatReadRef.current = true;
    onChatOpen?.();
  }, [defaultChatOpen, onChatOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      switch (event.key.toLowerCase()) {
        case "m":
          void trigger("selection");
          onToggleMute?.();
          break;
        case "v":
          void trigger("selection");
          onToggleVideo?.();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onToggleMute, onToggleVideo, trigger]);

  useEffect(() => clearLeaveTimeout, [clearLeaveTimeout]);

  return {
    handleLeave,
    handleTourComplete,
    handleCopyLink,
  };
}
