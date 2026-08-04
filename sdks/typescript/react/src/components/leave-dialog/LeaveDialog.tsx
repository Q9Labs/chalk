import React, { useEffect, useRef, useState } from "react";
import { CallEnd01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";

export interface LeaveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onEndEpisode?: () => void;
  className?: string;
}

export const LeaveDialog = React.memo<LeaveDialogProps>(({ isOpen, onClose, onConfirm, onEndEpisode, className }: LeaveDialogProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const portalTheme = resolvePortalThemeFromDocument();
  const modalRef = useRef<HTMLDivElement>(null);
  const [confirmingEndEpisode, setConfirmingEndEpisode] = useState(false);

  useEffect(() => {
    if (!isOpen) setConfirmingEndEpisode(false);
  }, [isOpen]);

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
      className={cn("chalk-root fixed inset-0 z-[100] flex items-center justify-center bg-[var(--chalk-stage)] p-4 backdrop-blur-[2px]", !prefersReducedMotion && "animate-in fade-in duration-200", className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-modal-title"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={cn(
          "relative w-full max-w-[420px] overflow-hidden rounded-[12px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]",
          !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] slide-in-from-bottom-4 duration-200 ease-out",
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] bg-[var(--chalk-danger-surface)] text-[var(--chalk-danger)]">
              <CallEnd01Icon size={22} />
            </div>

            <div>
              <h2 id="leave-modal-title" className="text-xl font-semibold tracking-[-0.025em]">
                {confirmingEndEpisode ? "End Episode for everyone?" : "Leave Space?"}
              </h2>
              <p className="mt-2 text-sm leading-6 text-[var(--chalk-muted-text)]">{confirmingEndEpisode ? "This ends the live Episode for every Participant. This action cannot be undone." : "You’ll leave this Space now. The Space link will still work if you need to rejoin."}</p>
            </div>
          </div>

          <div className="mt-7 flex gap-3">
            <button
              type="button"
              onClick={confirmingEndEpisode ? () => setConfirmingEndEpisode(false) : onClose}
              className="h-11 flex-1 rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] text-sm font-semibold text-[var(--chalk-text)] outline-none transition hover:bg-[var(--chalk-canvas)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]"
            >
              {confirmingEndEpisode ? "Back" : "Cancel"}
            </button>
            <button
              type="button"
              onClick={confirmingEndEpisode ? onEndEpisode : onConfirm}
              className={cn(
                "h-11 flex-1 rounded-[8px] bg-[var(--chalk-danger)] text-sm font-semibold text-[var(--chalk-accent-text)] outline-none transition hover:bg-[var(--chalk-danger)]",
                "focus-visible:ring-2 focus-visible:ring-[var(--chalk-danger-surface)] focus-visible:ring-offset-2",
                "active:scale-[0.98]",
              )}
            >
              {confirmingEndEpisode ? "End Episode" : "Leave"}
            </button>
          </div>
          {!confirmingEndEpisode && onEndEpisode ? (
            <button type="button" onClick={() => setConfirmingEndEpisode(true)} className="mt-3 h-11 w-full rounded-[8px] text-sm font-semibold text-[var(--chalk-danger)] outline-none transition hover:bg-[var(--chalk-danger-surface)] focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)]">
              End Episode for everyone
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
});

LeaveDialog.displayName = "LeaveDialog";
