import React from "react";
import { WifiOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { Spinner } from "../atomic/Spinner";

export interface ConnectionLostOverlayProps {
  isVisible: boolean;
  status: "connecting" | "reconnecting" | "failed";
  onRetry?: () => void;
  onLeave?: () => void;
  message?: string;
  supportCode?: string;
  className?: string;
}

export const ConnectionLostOverlay = React.memo<ConnectionLostOverlayProps>(({ isVisible, status, onRetry, onLeave, message, supportCode, className }) => {
  if (!isVisible) return null;

  const defaultMessages = {
    connecting: "Joining meeting...",
    reconnecting: "Connection lost. Reconnecting...",
    failed: "Unable to connect to the server.",
  };

  return (
    <div className={cn("fixed inset-0 z-50 flex items-center justify-center bg-background/95 transition-opacity duration-300", className)} role="alertdialog" aria-modal="true" aria-labelledby="connection-status-title" aria-describedby="connection-status-desc">
      <div className="flex flex-col items-center justify-center p-8 bg-background rounded-[var(--chalk-border-radius-lg)] shadow-[var(--chalk-shadow-xl)] max-w-sm w-full border border-border">
        {status === "failed" ? (
          <div className="mb-6 p-4 rounded-full bg-card text-destructive">
            <WifiOffIcon size={48} strokeWidth={1.5} />
          </div>
        ) : (
          <div className="mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <h2 id="connection-status-title" className="text-xl font-semibold text-foreground mb-2 text-center">
          {status === "failed" ? "Connection Failed" : "Connecting"}
        </h2>

        <p id="connection-status-desc" className="text-muted-foreground text-center mb-8">
          {message || defaultMessages[status]}
        </p>

        {supportCode && (
          <div className="w-full mb-6 rounded-[var(--chalk-border-radius-md)] border border-border bg-card p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Support Code</p>
            <p className="mt-1 break-all font-mono text-xs text-foreground">{supportCode}</p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex flex-col gap-3 w-full">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="w-full py-2.5 px-4 bg-primary hover:bg-primary/90 text-primary-foreground rounded-[var(--chalk-border-radius-md)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
              >
                Try Again
              </button>
            )}
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                className="w-full py-2.5 px-4 bg-card hover:bg-muted text-foreground rounded-[var(--chalk-border-radius-md)] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2"
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

ConnectionLostOverlay.displayName = "ConnectionLostOverlay";
