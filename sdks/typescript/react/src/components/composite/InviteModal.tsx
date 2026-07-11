import React, { useEffect, useRef, useState } from "react";
import { Cancel01Icon, Copy01Icon, Mail01Icon, Calendar01Icon, Link01Icon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Input } from "../atomic/Input";
import { IconButton } from "../atomic/IconButton";
import { usePrefersReducedMotion } from "../../internal/useMediaQuery";

export interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  meetingLink: string;
  meetingId?: string;
  onCopyLink?: () => void | Promise<void>;
  onShareEmail?: () => void;
  onShareCalendar?: () => void;
  className?: string;
}

export const InviteModal = React.memo<InviteModalProps>(({ isOpen, onClose, meetingLink, meetingId, onCopyLink, onShareEmail, onShareCalendar, className }: InviteModalProps) => {
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
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center p-4", "bg-background/80", className)} role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
      <div ref={modalRef} className={cn("w-full max-w-md overflow-hidden rounded-lg shadow-lg", "bg-card", "border border-border", !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200")}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id="invite-modal-title" className="text-lg font-semibold text-card-foreground">
            Invite Participants
          </h2>
          <IconButton icon={<Cancel01Icon size={20} />} variant="ghost" onClick={onClose} aria-label="Close" />
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-4">
            <Input label="Meeting Link" value={meetingLink} readOnly fullWidth icon={<Link01Icon size={16} />} iconPosition="left" onClick={(e) => (e.target as HTMLInputElement).select()} />
            {onCopyLink && (
              <button
                type="button"
                onClick={handleCopyLink}
                disabled={isCopyFeedbackVisible}
                className={cn("w-full flex items-center justify-center gap-2 py-2.5 rounded-md font-medium transition-colors", "bg-primary text-primary-foreground", "hover:opacity-90", isCopyFeedbackVisible && "opacity-90 cursor-default")}
              >
                <Copy01Icon size={18} />
                {isCopyFeedbackVisible ? "Copied" : "Copy Link"}
                <span className="sr-only" aria-live="polite">
                  {isCopyFeedbackVisible ? "Copied meeting link to clipboard" : ""}
                </span>
              </button>
            )}
          </div>

          {meetingId && (
            <div className={cn("flex items-center justify-between p-3 rounded-md", "bg-muted", "border border-border")}>
              <span className="text-sm text-muted-foreground">Meeting ID</span>
              <span className="font-mono font-medium text-card-foreground select-all">{meetingId}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {onShareEmail && (
              <button type="button" onClick={onShareEmail} className={cn("flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors", "bg-secondary text-secondary-foreground", "hover:bg-accent", "border border-border")}>
                <Mail01Icon size={16} />
                Email
              </button>
            )}
            {onShareCalendar && (
              <button type="button" onClick={onShareCalendar} className={cn("flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors", "bg-secondary text-secondary-foreground", "hover:bg-accent", "border border-border")}>
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

InviteModal.displayName = "InviteModal";
