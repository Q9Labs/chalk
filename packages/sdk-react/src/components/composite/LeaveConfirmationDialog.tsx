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
      className={cn(
        'fixed inset-0 z-[100] flex items-center justify-center p-4 backdrop-blur-sm',
        'bg-black/40',
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
          "w-full max-w-sm overflow-hidden rounded-2xl shadow-2xl",
          "bg-card",
          "border border-border",
          "p-6 space-y-6",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200"
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center space-y-3">
          <div className="p-3 rounded-full bg-destructive/10 text-destructive">
            <CallEnd01Icon size={24} />
          </div>
          <div className="space-y-1">
            <h2 id="leave-modal-title" className="text-xl font-bold text-card-foreground">
              Leave Meeting
            </h2>
            <p className="text-muted-foreground">
              Are you sure you want to leave the current meeting?
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <button
            onClick={onConfirm}
            className={cn(
              "w-full py-3 rounded-xl font-semibold transition-all active:scale-[0.98]",
              "bg-destructive text-destructive-foreground hover:opacity-90 shadow-md shadow-destructive/20"
            )}
          >
            Leave Meeting
          </button>
          <button
            onClick={onClose}
            className={cn(
              "w-full py-3 rounded-xl font-semibold transition-all",
              "bg-secondary text-secondary-foreground hover:bg-accent border border-border"
            )}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
});

LeaveConfirmationDialog.displayName = 'LeaveConfirmationDialog';
