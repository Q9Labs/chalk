import React, { useEffect, useRef } from "react";
import { CallEnd01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";
import { resolvePortalThemeFromDocument } from "../../utils/theme";

export interface LeaveDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  className?: string;
}

export const LeaveDialog = React.memo<LeaveDialogProps>(({ isOpen, onClose, onConfirm, className }: LeaveDialogProps) => {
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
      className={cn("chalk-root fixed inset-0 z-[100] flex items-center justify-center bg-[#0c0e12]/35 p-4 backdrop-blur-[2px]", !prefersReducedMotion && "animate-in fade-in duration-200", className)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-modal-title"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={cn("relative w-full max-w-[420px] overflow-hidden rounded-[12px] border border-[#c9c8c2] bg-white text-[#0c0e12] shadow-[0_24px_64px_rgba(12,14,18,0.2)]", !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] slide-in-from-bottom-4 duration-200 ease-out")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-[8px] bg-[#fdf0f0] text-[#b94c4c]">
              <CallEnd01Icon size={22} />
            </div>

            <div>
              <h2 id="leave-modal-title" className="text-xl font-semibold tracking-[-0.025em]">
                Leave meeting?
              </h2>
              <p className="mt-2 text-sm leading-6 text-[#555b65]">You’ll leave this call now. The meeting link will still work if you need to rejoin.</p>
            </div>
          </div>

          <div className="mt-7 flex gap-3">
            <button type="button" onClick={onClose} className="h-11 flex-1 rounded-[8px] border border-[#c9c8c2] bg-white text-sm font-semibold text-[#202329] outline-none transition hover:bg-[#f7f6f2] focus-visible:ring-2 focus-visible:ring-[#dff2f7]">
              Cancel
            </button>
            <button type="button" onClick={onConfirm} className={cn("h-11 flex-1 rounded-[8px] bg-[#c94343] text-sm font-semibold text-white outline-none transition hover:bg-[#b33b3b]", "focus-visible:ring-2 focus-visible:ring-[#ef9b9b] focus-visible:ring-offset-2", "active:scale-[0.98]")}>
              Leave
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

LeaveDialog.displayName = "LeaveDialog";
