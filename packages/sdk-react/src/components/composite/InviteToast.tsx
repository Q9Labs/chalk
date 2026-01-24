import { memo, useCallback, useEffect, useState } from 'react';
import { Cancel01Icon, Copy01Icon, UserGroupIcon, Tick01Icon } from '../../utils/icons';
import { cn } from '../../utils/cn';
import { usePrefersReducedMotion } from '../../hooks/useMediaQuery';

export interface InviteToastProps {
  isVisible: boolean;
  onDismiss: () => void;
  meetingLink: string;
  /** Auto-dismiss delay in ms. Set to 0 to disable. Default: 8000 */
  autoDismissDelay?: number;
  className?: string;
}

export const InviteToast = memo<InviteToastProps>(({
  isVisible,
  onDismiss,
  meetingLink,
  autoDismissDelay = 8000,
  className,
}) => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const [copied, setCopied] = useState(false);
  const [isExiting, setIsExiting] = useState(false);

  const handleDismiss = useCallback(() => {
    setIsExiting(true);
    setTimeout(() => {
      setIsExiting(false);
      onDismiss();
    }, 200);
  }, [onDismiss]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(meetingLink);
      setCopied(true);
      setTimeout(handleDismiss, 1000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = meetingLink;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(handleDismiss, 1000);
    }
  }, [meetingLink, handleDismiss]);

  // Auto-dismiss timer
  useEffect(() => {
    if (!isVisible || autoDismissDelay === 0) return;

    const timer = setTimeout(handleDismiss, autoDismissDelay);
    return () => clearTimeout(timer);
  }, [isVisible, autoDismissDelay, handleDismiss]);

  // Reset copied state when visibility changes
  useEffect(() => {
    if (!isVisible) setCopied(false);
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div
      className={cn(
        'fixed bottom-24 left-4 z-50 max-w-sm',
        !prefersReducedMotion && !isExiting && 'animate-in slide-in-from-left-4 fade-in duration-300',
        !prefersReducedMotion && isExiting && 'animate-out slide-out-to-left-4 fade-out duration-200',
        className
      )}
      role="status"
      aria-live="polite"
    >
      <div className="bg-card/95 backdrop-blur-xl rounded-xl shadow-2xl border border-border/50 overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-4 pb-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
              <UserGroupIcon className="w-5 h-5 text-primary" />
            </div>
            <div>
              <p className="font-semibold text-card-foreground">Your meeting's ready</p>
              <p className="text-sm text-muted-foreground">Share this link to invite others</p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="p-1 rounded-md text-muted-foreground hover:text-card-foreground hover:bg-muted/50 transition-colors"
            aria-label="Dismiss"
          >
            <Cancel01Icon size={16} />
          </button>
        </div>

        {/* Link preview */}
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 border border-border/50">
            <span className="text-sm text-muted-foreground truncate flex-1 font-mono">
              {meetingLink.replace(/^https?:\/\//, '')}
            </span>
          </div>
        </div>

        {/* Action */}
        <div className="px-4 pb-4">
          <button
            onClick={handleCopy}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg font-medium transition-all',
              copied
                ? 'bg-green-600/20 text-green-400 border border-green-600/30'
                : 'bg-primary text-primary-foreground hover:opacity-90'
            )}
          >
            {copied ? (
              <>
                <Tick01Icon size={18} />
                Copied!
              </>
            ) : (
              <>
                <Copy01Icon size={18} />
                Copy meeting link
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
});

InviteToast.displayName = 'InviteToast';
