import React from "react";
import { WifiOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Spinner } from "../atomic/Spinner";

export interface ReconnectingOverlayProps {
  isVisible: boolean;
  status: "connecting" | "reconnecting" | "failed";
  onRetry?: () => void;
  onLeft?: () => void;
  message?: string;
  supportCode?: string;
  className?: string;
}

export const ReconnectingOverlay = React.memo<ReconnectingOverlayProps>(({ isVisible, status, onRetry, onLeft, message, supportCode, className }) => {
  if (!isVisible) return null;

  const defaultMessages = {
    connecting: "Joining space...",
    reconnecting: "Connection lost. Reconnecting...",
    failed: "Unable to connect to the server.",
  };

  return (
    <div className={cn("absolute inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-300", className)} role="alertdialog" aria-modal="true" aria-labelledby="connection-status-title" aria-describedby="connection-status-desc">
      <div aria-hidden="true" className="absolute inset-0 bg-[var(--chalk-stage)] opacity-90 backdrop-blur-[2px]" />
      <div className="relative flex w-full max-w-sm flex-col items-center justify-center rounded-[12px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-8 text-[var(--chalk-text)] shadow-[var(--chalk-shadow)]">
        {status === "failed" ? (
          <div className="mb-6 rounded-full bg-[var(--chalk-danger-surface)] p-4 text-[var(--chalk-danger)]">
            <WifiOffIcon size={48} strokeWidth={1.5} />
          </div>
        ) : (
          <div className="mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <h2 id="connection-status-title" className="mb-2 text-center text-xl font-semibold text-[var(--chalk-text)]">
          {status === "failed" ? "Connection Failed" : "Connecting"}
        </h2>

        <p id="connection-status-desc" className="mb-8 text-center text-[var(--chalk-muted-text)]">
          {message || defaultMessages[status]}
        </p>

        {supportCode && (
          <div className="mb-6 w-full rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--chalk-muted-text)]">Support Code</p>
            <p className="mt-1 break-all font-mono text-xs text-[var(--chalk-text)]">{supportCode}</p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex w-full flex-col gap-3">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="w-full rounded-[8px] bg-[var(--chalk-text)] px-4 py-2.5 font-medium text-[var(--chalk-accent-text)] transition-colors hover:bg-[var(--chalk-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] focus-visible:ring-offset-2"
              >
                Try Again
              </button>
            )}
            {onLeft && (
              <button
                type="button"
                onClick={onLeft}
                className="w-full rounded-[8px] border border-[var(--chalk-line)] bg-[var(--chalk-surface)] px-4 py-2.5 font-medium text-[var(--chalk-text)] transition-colors hover:bg-[var(--chalk-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-focus)] focus-visible:ring-offset-2"
              >
                Leave Space
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

ReconnectingOverlay.displayName = "ReconnectingOverlay";
