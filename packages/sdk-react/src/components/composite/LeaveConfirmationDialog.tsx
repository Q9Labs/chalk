import React, { useEffect, useRef } from 'react';
import { CallEnd01Icon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface LeaveConfirmationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  className?: string;
}

export const LeaveConfirmationDialog = React.memo<LeaveConfirmationDialogProps>(({
  isOpen,
  onClose,
  onConfirm,
  className,
}: LeaveConfirmationDialogProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const modalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
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
      className={cn(
        'chalk-root fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm',
        'bg-transparent',
        className
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="leave-modal-title"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className={cn(
          "w-full max-w-sm overflow-hidden rounded-2xl relative",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200"
        )}
        style={{
          background: "var(--chalk-lobby-glass-bg)",
          border: "1px solid var(--chalk-lobby-glass-border)",
          backdropFilter: "blur(20px)",
          boxShadow: "var(--chalk-shadow-xl)",
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="p-6 space-y-6">
          <div className="flex flex-col items-center text-center space-y-4">
            <div 
              className="p-4 rounded-full"
              style={{ background: "oklch(from var(--destructive) l c h / 0.15)" }}
            >
              <CallEnd01Icon size={28} className="text-(--destructive)" />
            </div>
            <div className="space-y-2">
              <h2 id="leave-modal-title" className="text-2xl font-bold text-(--foreground) tracking-tight">
                Leave Meeting
              </h2>
              <p className="text-(--muted-foreground) text-balance">
                Are you sure you want to leave the current meeting?
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <button
              onClick={onConfirm}
              className={cn(
                "w-full py-3.5 rounded-xl font-bold transition-all active:scale-[0.98] text-white",
                "bg-(--destructive) hover:opacity-90 shadow-lg shadow-destructive/20"
              )}
            >
              Leave Meeting
            </button>
            <button
              onClick={onClose}
              className={cn(
                "w-full py-3.5 rounded-xl font-semibold transition-all text-(--foreground)",
                "bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 border border-black/5 dark:border-white/5"
              )}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

LeaveConfirmationDialog.displayName = 'LeaveConfirmationDialog';
