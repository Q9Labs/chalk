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
    <div className={cn("absolute inset-0 z-50 flex items-center justify-center bg-[#fbfaf7]/90 p-4 backdrop-blur-[2px] transition-opacity duration-300", className)} role="alertdialog" aria-modal="true" aria-labelledby="connection-status-title" aria-describedby="connection-status-desc">
      <div className="flex w-full max-w-sm flex-col items-center justify-center rounded-[12px] border border-[#deddd7] bg-[#fbfaf7] p-8 text-[#0c0e12] shadow-[0_24px_70px_rgba(12,14,18,0.16)]">
        {status === "failed" ? (
          <div className="mb-6 rounded-full bg-[#f8e4e4] p-4 text-[#9f3f3f]">
            <WifiOffIcon size={48} strokeWidth={1.5} />
          </div>
        ) : (
          <div className="mb-6">
            <Spinner size="lg" />
          </div>
        )}

        <h2 id="connection-status-title" className="mb-2 text-center text-xl font-semibold text-[#0c0e12]">
          {status === "failed" ? "Connection Failed" : "Connecting"}
        </h2>

        <p id="connection-status-desc" className="mb-8 text-center text-[#6d727b]">
          {message || defaultMessages[status]}
        </p>

        {supportCode && (
          <div className="mb-6 w-full rounded-[8px] border border-[#deddd7] bg-white p-3">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#6d727b]">Support Code</p>
            <p className="mt-1 break-all font-mono text-xs text-[#0c0e12]">{supportCode}</p>
          </div>
        )}

        {status === "failed" && (
          <div className="flex w-full flex-col gap-3">
            {onRetry && (
              <button type="button" onClick={onRetry} className="w-full rounded-[8px] bg-[#202329] px-4 py-2.5 font-medium text-white transition-colors hover:bg-[#343840] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#74b7cf] focus-visible:ring-offset-2">
                Try Again
              </button>
            )}
            {onLeave && (
              <button
                type="button"
                onClick={onLeave}
                className="w-full rounded-[8px] border border-[#deddd7] bg-white px-4 py-2.5 font-medium text-[#202329] transition-colors hover:bg-[#f7f6f2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#74b7cf] focus-visible:ring-offset-2"
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
