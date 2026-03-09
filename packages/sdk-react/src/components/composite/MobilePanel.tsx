import React, { useCallback, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ArrowLeft02Icon, Cancel01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../hooks/useMediaQuery";

export interface MobilePanelProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Show back arrow instead of X button */
  showBackButton?: boolean;
  className?: string;
  /** Controlled open state - when provided, panel acts as controlled component */
  isOpen?: boolean;
}

const SWIPE_THRESHOLD = 100;
const SWIPE_VELOCITY_THRESHOLD = 0.5;

export const MobilePanel = React.memo(({ title, onClose, children, showBackButton = true, className, isOpen = true }: MobilePanelProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [translateX, setTranslateX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartRef = useRef<{ x: number; time: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, time: Date.now() };
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;

    const deltaX = touch.clientX - touchStartRef.current.x;
    // Only allow swiping right (to close)
    if (deltaX > 0) {
      setTranslateX(deltaX);
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!touchStartRef.current) return;

    const deltaTime = Date.now() - touchStartRef.current.time;
    const velocity = translateX / deltaTime;

    // Close if swipe distance or velocity threshold met
    if (translateX > SWIPE_THRESHOLD || velocity > SWIPE_VELOCITY_THRESHOLD) {
      onClose();
    } else {
      setTranslateX(0);
    }

    setIsDragging(false);
    touchStartRef.current = null;
  }, [translateX, onClose]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose],
  );

  return (
    <Dialog.Root open={isOpen} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={cn("fixed inset-0 bg-black/50 z-40", !prefersReducedMotion && "transition-opacity duration-300")} />
        <Dialog.Popup
          className={cn("fixed inset-0 z-50 flex flex-col bg-card", !prefersReducedMotion && !isDragging && "transition-transform duration-300 ease-out", !isDragging && translateX === 0 && !prefersReducedMotion && "animate-in slide-in-from-right duration-300", className)}
          style={{
            transform: translateX > 0 ? `translateX(${translateX}px)` : undefined,
            // Safe area insets for iOS
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "env(safe-area-inset-bottom)",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>

          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <button type="button" onClick={onClose} className="flex items-center justify-center w-11 h-11 -ml-2 rounded-full active:bg-muted transition-colors" aria-label={showBackButton ? "Go back" : "Close"}>
              {showBackButton ? <ArrowLeft02Icon className="w-6 h-6 text-foreground" /> : <Cancel01Icon className="w-6 h-6 text-foreground" />}
            </button>
            <h2 className="text-lg font-semibold text-foreground flex-1 text-center mr-11">{title}</h2>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-hidden">{children}</div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
});

MobilePanel.displayName = "MobilePanel";
