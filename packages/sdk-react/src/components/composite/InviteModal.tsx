import React, { useEffect, useRef } from 'react';
import { X, Copy, Mail, Calendar, Link as LinkIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Input } from '../atomic/Input';
import { IconButton } from '../atomic/IconButton';

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

export const InviteModal: React.FC<InviteModalProps> = ({
  isOpen,
  onClose,
  meetingLink,
  meetingId,
  onCopyLink,
  onShareEmail,
  onShareCalendar,
  className,
}) => {
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
        'fixed inset-0 z-50 flex items-center justify-center p-4 bg-[var(--chalk-bg-overlay)] backdrop-blur-sm',
        className
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-modal-title"
    >
      <div 
        ref={modalRef}
        className="w-full max-w-md bg-[var(--chalk-bg-primary)] rounded-[var(--chalk-border-radius-lg)] shadow-[var(--chalk-shadow-xl)] border border-[var(--chalk-border-color)] overflow-hidden animate-in fade-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--chalk-border-color)]">
          <h2 id="invite-modal-title" className="text-lg font-semibold text-[var(--chalk-text-primary)]">
            Invite Participants
          </h2>
          <IconButton
            icon={<X size={20} />}
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
              icon={<LinkIcon size={16} />}
              iconPosition="left"
              onClick={(e) => (e.target as HTMLInputElement).select()}
            />
            {onCopyLink && (
              <button
                onClick={onCopyLink}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-[var(--chalk-primary)] hover:bg-[var(--chalk-primary-hover)] text-white rounded-[var(--chalk-border-radius-md)] font-medium transition-colors"
              >
                <Copy size={18} />
                Copy Link
              </button>
            )}
          </div>

          {meetingId && (
             <div className="flex items-center justify-between p-3 bg-[var(--chalk-bg-secondary)] rounded-[var(--chalk-border-radius-md)] border border-[var(--chalk-border-color)]">
               <span className="text-sm text-[var(--chalk-text-secondary)]">Meeting ID</span>
               <span className="font-mono font-medium text-[var(--chalk-text-primary)] select-all">
                 {meetingId}
               </span>
             </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            {onShareEmail && (
              <button
                onClick={onShareEmail}
                className="flex items-center justify-center gap-2 py-2 px-4 bg-[var(--chalk-bg-secondary)] hover:bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] rounded-[var(--chalk-border-radius-md)] text-sm font-medium transition-colors border border-[var(--chalk-border-color)]"
              >
                <Mail size={16} />
                Email
              </button>
            )}
            {onShareCalendar && (
              <button
                onClick={onShareCalendar}
                className="flex items-center justify-center gap-2 py-2 px-4 bg-[var(--chalk-bg-secondary)] hover:bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] rounded-[var(--chalk-border-radius-md)] text-sm font-medium transition-colors border border-[var(--chalk-border-color)]"
              >
                <Calendar size={16} />
                Calendar
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
