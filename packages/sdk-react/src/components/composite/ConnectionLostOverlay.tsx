import React from 'react';
import { WifiOff } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Spinner } from '../atomic/Spinner';

export interface ConnectionLostOverlayProps {
  isVisible: boolean;
  status: 'connecting' | 'reconnecting' | 'failed';
  onRetry?: () => void;
  onLeave?: () => void;
  message?: string;
  className?: string;
}

export const ConnectionLostOverlay: React.FC<ConnectionLostOverlayProps> = ({
  isVisible,
  status,
  onRetry,
  onLeave,
  message,
  className,
}) => {
  if (!isVisible) return null;

  const defaultMessages = {
    connecting: 'Joining meeting...',
    reconnecting: 'Connection lost. Reconnecting...',
    failed: 'Unable to connect to the server.',
  };

  return (
    <div
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-[var(--chalk-bg-overlay)] backdrop-blur-sm transition-opacity duration-300',
        className
      )}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-status-title"
      aria-describedby="connection-status-desc"
    >
      <div className="flex flex-col items-center justify-center p-8 bg-[var(--chalk-bg-primary)] rounded-[var(--chalk-border-radius-lg)] shadow-[var(--chalk-shadow-xl)] max-w-sm w-full border border-[var(--chalk-border-color)]">
        
        {status === 'failed' ? (
          <div className="mb-6 p-4 rounded-full bg-[var(--chalk-bg-secondary)] text-[var(--chalk-danger)]">
            <WifiOff size={48} strokeWidth={1.5} />
          </div>
        ) : (
          <div className="mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <h2 
          id="connection-status-title"
          className="text-xl font-semibold text-[var(--chalk-text-primary)] mb-2 text-center"
        >
          {status === 'failed' ? 'Connection Failed' : 'Connecting'}
        </h2>

        <p 
          id="connection-status-desc"
          className="text-[var(--chalk-text-secondary)] text-center mb-8"
        >
          {message || defaultMessages[status]}
        </p>

        {status === 'failed' && (
          <div className="flex flex-col gap-3 w-full">
            {onRetry && (
              <button
                onClick={onRetry}
                className="w-full py-2.5 px-4 bg-[var(--chalk-primary)] hover:bg-[var(--chalk-primary-hover)] text-white rounded-[var(--chalk-border-radius-md)] font-medium transition-colors"
              >
                Try Again
              </button>
            )}
            {onLeave && (
              <button
                onClick={onLeave}
                className="w-full py-2.5 px-4 bg-[var(--chalk-bg-secondary)] hover:bg-[var(--chalk-bg-tertiary)] text-[var(--chalk-text-primary)] rounded-[var(--chalk-border-radius-md)] font-medium transition-colors"
              >
                Leave Meeting
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
