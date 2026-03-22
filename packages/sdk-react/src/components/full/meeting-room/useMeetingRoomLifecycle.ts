import { useCallback, useEffect, useRef } from "react";

interface UseMeetingRoomLifecycleOptions {
  meetingLink?: string;
  enableTour: boolean;
  showTourOnFirstVisit: boolean;
  defaultChatOpen: boolean;
  onChatOpen?: () => void;
  onLeave?: () => void;
  onTourComplete?: () => void;
  setShowTour: (show: boolean) => void;
  setIsExiting: (exiting: boolean) => void;
}

const LEAVE_ANIMATION_MS = 600;

export function useMeetingRoomLifecycle({ meetingLink, enableTour, showTourOnFirstVisit, defaultChatOpen, onChatOpen, onLeave, onTourComplete, setShowTour, setIsExiting }: UseMeetingRoomLifecycleOptions) {
  const leaveTimeoutRef = useRef<number | null>(null);
  const hasMarkedDefaultChatReadRef = useRef(false);

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
    navigator.clipboard.writeText(meetingLink ?? window.location.href);
  }, [meetingLink]);

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

  useEffect(() => clearLeaveTimeout, [clearLeaveTimeout]);

  return {
    handleLeave,
    handleTourComplete,
    handleCopyLink,
  };
}
