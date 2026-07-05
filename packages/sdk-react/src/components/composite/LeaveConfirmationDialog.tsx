import React, { useEffect, useRef } from "react";
import { CallEnd01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";

export interface LeaveConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  className?: string;
}

export const LeaveConfirmationDialog = React.memo<LeaveConfirmationDialogProps>(({ isOpen, onClose, onConfirm, className }: LeaveConfirmationDialogProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  // Close when clicking backdrop
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      data-chalk
      data-chalk-theme={portalTheme}
      className={cn("chalk-root fixed inset-0 z-[100] flex items-center justify-center p-4", "bg-background/80", !prefersReducedMotion && "animate-in fade-in duration-200", className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-modal-title"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={cn("w-full max-w-[400px] overflow-hidden rounded-[24px] relative", "bg-card text-card-foreground shadow-2xl border border-border/50", !prefersReducedMotion && "animate-in fade-in zoom-in-[0.95] slide-in-from-bottom-4 duration-300 ease-out")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-8">
          <div className="flex flex-col items-center text-center space-y-5">
            <div className="w-16 h-16 rounded-full flex items-center justify-center relative">
              <div className="absolute inset-0 bg-destructive/10 rounded-full animate-ping" style={{ animationDuration: "3s" }} />
              <div className="absolute inset-0 bg-destructive/20 rounded-full" />
              <CallEnd01Icon size={28} className="text-destructive relative z-10" />
            </div>

            <div className="space-y-2">
              <h2 id="leave-modal-title" className="text-xl font-bold tracking-tight">
                Leave Meeting?
              </h2>
              <p className="text-muted-foreground text-sm leading-relaxed">You will be disconnected from the current session. You can always rejoin using the meeting link later.</p>
            </div>
          </div>

          <div className="flex gap-3 mt-8">
            <button onClick={onClose} className={cn("flex-1 h-11 rounded-xl font-medium text-sm transition-all outline-none", "bg-secondary/50 text-secondary-foreground hover:bg-secondary border border-transparent", "focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-border")}>
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className={cn(
                "flex-1 h-11 rounded-xl font-medium text-sm transition-all outline-none text-white",
                "bg-[#dc2626] shadow-lg hover:bg-[#b91c1c]",
                "focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                "active:scale-[0.98]",
              )}
            >
              Leave
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

LeaveConfirmationDialog.displayName = "LeaveConfirmationDialog";
