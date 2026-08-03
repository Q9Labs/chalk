import React from "react";
import { WifiOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Spinner } from "../atomic/Spinner";

export interface ReconnectingOverlayProps {
  isVisible: boolean;
  status: "connecting" | "reconnecting" | "failed";
  onRetry?: () => void;
  onLeave?: () => void;
  message?: string;
  supportCode?: string;
  className?: string;
}

export const ReconnectingOverlay = React.memo<ReconnectingOverlayProps>(({ isVisible, status, onRetry, onLeave, message, supportCode, className }) => {
  if (!isVisible) return null;

  const defaultMessages = {
    connecting: "Joining meeting...",
    reconnecting: "Connection lost. Reconnecting...",
    failed: "Unable to connect to the server.",
  };

  return (
    <div
      className={cn("absolute inset-0 z-50 flex items-center justify-center bg-[var(--chalk-app-canvas)]/90 p-4 backdrop-blur-[2px] transition-opacity duration-300", className)}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="connection-status-title"
      aria-describedby="connection-status-desc"
    >
      <div className="chalk-textured-surface flex w-full max-w-sm flex-col items-center justify-center rounded-[12px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-panel)] p-8 text-[var(--chalk-app-text)] shadow-[var(--chalk-app-shadow-sm)]">
        {status === "failed" ? (
          <div className="mb-6 rounded-full bg-[var(--chalk-app-danger)]/10 p-4 text-[var(--chalk-app-danger)]">
            <WifiOffIcon size={48} strokeWidth={1.5} />
          </div>
        ) : (
          <div className="mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <h2 id="connection-status-title" className="mb-2 text-center text-xl font-semibold text-[var(--chalk-app-text)]">
          {status === "failed" ? "Connection Failed" : "Connecting"}
        </h2>

        <p id="connection-status-desc" className="mb-8 text-center text-[var(--chalk-app-text-muted)]">
          {message || defaultMessages[status]}
        </p>

        {supportCode && (
          <div className="mb-6 w-full rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--chalk-app-text-muted)]">Support Code</p>
            <p className="mt-1 break-all font-mono text-xs text-[var(--chalk-app-text)]">{supportCode}</p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex w-full flex-col gap-3">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="w-full rounded-[8px] bg-[var(--chalk-app-control-primary)] px-4 py-2.5 font-medium text-white transition-colors hover:bg-[var(--chalk-app-control-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2"
              >
                Try Again
              </button>
            )}
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                className="w-full rounded-[8px] border border-[var(--chalk-app-line)] bg-[var(--chalk-app-control)] px-4 py-2.5 font-medium text-[var(--chalk-app-text)] transition-colors hover:bg-[var(--chalk-app-control-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)] focus-visible:ring-offset-2"
              >
                Leave Meeting
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

ReconnectingOverlay.displayName = "ReconnectingOverlay";
