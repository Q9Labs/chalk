import React, { useEffect, useRef, useState } from "react";
import { Cancel01Icon, Copy01Icon, Mail01Icon, Calendar01Icon, Link01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Input } from "../atomic/Input";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";

export interface InviteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  inviteLink: string;
  spaceId?: string;
  onCopyLink?: () => void | Promise<void>;
  onShareEmail?: () => void;
  onShareCalendar?: () => void;
  className?: string;
}

export const InviteDialog = React.memo<InviteDialogProps>(({ isOpen, onClose, inviteLink, spaceId, onCopyLink, onShareEmail, onShareCalendar, className }: InviteDialogProps) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const modalRef = useRef<HTMLDivElement>(null);
  const copyResetTimeoutRef = useRef<number | null>(null);
  const [isCopyFeedbackVisible, setIsCopyFeedbackVisible] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current) {
        window.clearTimeout(copyResetTimeoutRef.current);
        copyResetTimeoutRef.current = null;
      }
    };
  }, []);

  const handleCopyLink = async () => {
    if (!onCopyLink) return;
    await onCopyLink();
    setIsCopyFeedbackVisible(true);
    if (copyResetTimeoutRef.current) {
      window.clearTimeout(copyResetTimeoutRef.current);
    }
    copyResetTimeoutRef.current = window.setTimeout(() => {
      setIsCopyFeedbackVisible(false);
      copyResetTimeoutRef.current = null;
    }, 1200);
  };

  if (!isOpen) return null;

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-[var(--chalk-stage)] p-4 backdrop-blur-[2px]", className)} role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
      <div ref={modalRef} className={cn("w-full max-w-md overflow-hidden rounded-[12px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] shadow-[var(--chalk-shadow)]", !prefersReducedMotion && "animate-in fade-in zoom-in-[0.97] duration-200")}>
        <div className="flex items-center justify-between border-b border-[var(--chalk-line)] px-5 py-4">
          <h2 id="invite-modal-title" className="text-xl font-semibold tracking-[-0.025em] text-[var(--chalk-text)]">
            Invite people
          </h2>
          <button type="button" onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full border border-[var(--chalk-line)] text-[var(--chalk-muted-text)] transition hover:bg-[var(--chalk-canvas)] hover:text-[var(--chalk-text)]" aria-label="Close invite dialog">
            <Cancel01Icon size={19} />
          </button>
        </div>

        <div className="space-y-5 p-5">
          <div className="space-y-4">
            <Input label="Space link" value={inviteLink} readOnly fullWidth icon={<Link01Icon size={16} />} iconPosition="left" onClick={(e) => (e.target as HTMLInputElement).select()} />
            {onCopyLink && (
              <button
                type="button"
                onClick={handleCopyLink}
                disabled={isCopyFeedbackVisible}
                className={cn("flex h-11 w-full items-center justify-center gap-2 rounded-[8px] bg-[var(--chalk-text)] text-sm font-semibold text-[var(--chalk-accent-text)] transition-colors hover:bg-[var(--chalk-text)]", isCopyFeedbackVisible && "cursor-default bg-[var(--chalk-accent)]")}
              >
                <Copy01Icon size={18} />
                {isCopyFeedbackVisible ? "Copied" : "Copy Link"}
                <span className="sr-only" aria-live="polite">
                  {isCopyFeedbackVisible ? "Copied space link to clipboard" : ""}
                </span>
              </button>
            )}
          </div>

          {spaceId && (
            <div className="flex items-center justify-between rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-3">
              <span className="text-sm text-[var(--chalk-muted-text)]">Space ID</span>
              <span className="select-all font-mono text-sm font-medium text-[var(--chalk-text)]">{spaceId}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {onShareEmail && (
              <button type="button" onClick={onShareEmail} className="flex h-11 items-center justify-center gap-2 rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-4 text-sm font-semibold text-[var(--chalk-text)] transition hover:bg-[var(--chalk-canvas)]">
                <Mail01Icon size={16} />
                Email
              </button>
            )}
            {onShareCalendar && (
              <button type="button" onClick={onShareCalendar} className="flex h-11 items-center justify-center gap-2 rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-4 text-sm font-semibold text-[var(--chalk-text)] transition hover:bg-[var(--chalk-canvas)]">
                <Calendar01Icon size={16} />
                Calendar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

InviteDialog.displayName = "InviteDialog";
