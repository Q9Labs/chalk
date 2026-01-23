import React, { useEffect, useRef } from 'react';
import { Cancel01Icon, Copy01Icon, Mail01Icon, Calendar01Icon, Link01Icon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { Input } from '../atomic/Input';
import { IconButton } from '../atomic/IconButton';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  meetingLink: string;
  meetingId?: string;
  onCopyLink?: () => void;
  onShareEmail?: () => void;
  onShareCalendar?: () => void;
  className?: string;
}

export const InviteModal = React.memo<InviteModalProps>(({
  isOpen,
  onClose,
  meetingLink,
  meetingId,
  onCopyLink,
  onShareEmail,
  onShareCalendar,
  className,
}: InviteModalProps) => {
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

  if (!isOpen) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm',
        'bg-[var(--background,var(--chalk-bg-overlay))]/80',
        className
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
    >
      <div
        ref={modalRef}
        className={cn(
          "w-full max-w-md overflow-hidden rounded-lg shadow-lg",
          "bg-[var(--card,var(--chalk-bg-primary))]",
          "border border-[var(--border,var(--chalk-border-color))]",
          !prefersReducedMotion && "animate-in fade-in zoom-in-95 duration-200"
        )}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border,var(--chalk-border-color))]">
          <h2 id="invite-modal-title" className="text-lg font-semibold text-[var(--card-foreground,var(--chalk-text-primary))]">
            Invite Participants
          </h2>
          <IconButton
            icon={<Cancel01Icon size={20} />}
            variant="ghost"
            onClick={onClose}
            aria-label="Close"
          />
        </div>

        <div className="p-6 space-y-6">
          <div className="space-y-4">
            <Input
              label="Meeting Link"
              value={meetingLink}
              readOnly
              fullWidth
              icon={<Link01Icon size={16} />}
              iconPosition="left"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            {onCopyLink && (
              <button
                onClick={onCopyLink}
                className={cn(
                  "w-full flex items-center justify-center gap-2 py-2.5 rounded-md font-medium transition-colors",
                  "bg-[var(--primary,var(--chalk-primary))] text-[var(--primary-foreground,#fff)]",
                  "hover:opacity-90"
                )}
              >
                <Copy01Icon size={18} />
                Copy Link
              </button>
            )}
          </div>

          {meetingId && (
            <div className={cn(
              "flex items-center justify-between p-3 rounded-md",
              "bg-[var(--muted,var(--chalk-bg-secondary))]",
              "border border-[var(--border,var(--chalk-border-color))]"
            )}>
              <span className="text-sm text-[var(--muted-foreground,var(--chalk-text-secondary))]">Meeting ID</span>
              <span className="font-mono font-medium text-[var(--card-foreground,var(--chalk-text-primary))] select-all">
                {meetingId}
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {onShareEmail && (
              <button
                onClick={onShareEmail}
                className={cn(
                  "flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors",
                  "bg-[var(--secondary,var(--chalk-bg-secondary))] text-[var(--secondary-foreground,var(--chalk-text-primary))]",
                  "hover:bg-[var(--accent,var(--chalk-bg-tertiary))]",
                  "border border-[var(--border,var(--chalk-border-color))]"
                )}
              >
                <Mail01Icon size={16} />
                Email
              </button>
            )}
            {onShareCalendar && (
              <button
                onClick={onShareCalendar}
                className={cn(
                  "flex items-center justify-center gap-2 py-2 px-4 rounded-md text-sm font-medium transition-colors",
                  "bg-[var(--secondary,var(--chalk-bg-secondary))] text-[var(--secondary-foreground,var(--chalk-text-primary))]",
                  "hover:bg-[var(--accent,var(--chalk-bg-tertiary))]",
                  "border border-[var(--border,var(--chalk-border-color))]"
                )}
              >
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

InviteModal.displayName = 'InviteModal';
