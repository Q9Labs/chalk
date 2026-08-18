import React from "react";
import { ChalkBackdrop, ChalkBadge, ChalkButton, ChalkDialogPanel, ChalkPanel, ChalkSpinner } from "../chalk-ui";
import { WifiOffIcon } from "../../utils/icons";
import { cn } from "../../utils/cn";
import { useSkin } from "../skin-context";
import { ClassicReconnectingOverlay } from "./ClassicReconnectingOverlay";

export interface ReconnectingOverlayProps {
  isVisible: boolean;
  status: "connecting" | "reconnecting" | "failed";
  onRetry?: () => void;
  onLeft?: () => void;
  message?: string;
  supportCode?: string;
  className?: string;
}

const ChalkReconnectingOverlay = React.memo<ReconnectingOverlayProps>(({ isVisible, status, onRetry, onLeft, message, supportCode, className }) => {
  const skin = useSkin();
  if (!isVisible) return null;

  const defaultMessages = {
    connecting: "Joining space...",
    reconnecting: "Connection lost. Reconnecting...",
    failed: "Unable to connect to the server.",
  };

  return (
    <div data-chalk-skin={skin} className={cn("absolute inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-300", className)} role="alertdialog" aria-modal="true" aria-labelledby="connection-status-title" aria-describedby="connection-status-desc">
      <ChalkBackdrop className="absolute inset-0 bg-[var(--chalk-app-canvas)] opacity-90 backdrop-blur-[2px]" style={{ position: "absolute" }} />
      <ChalkDialogPanel role="presentation" className="relative flex w-full max-w-sm flex-col items-center justify-center p-8 text-[var(--chalk-app-text)]" tone="neutral">
        {status === "failed" ? (
          <ChalkBadge tone="danger" className="mb-6 size-20 min-h-0 min-w-0 p-4 text-[var(--chalk-app-danger)]">
            <WifiOffIcon size={48} strokeWidth={1.5} />
          </ChalkBadge>
        ) : (
          <div className="mb-6">
            <ChalkSpinner tone="accent" className="size-12" />
          </div>
        )}

        <h2 id="connection-status-title" className="mb-2 text-center text-xl font-semibold text-[var(--chalk-app-text)]">
          {status === "failed" ? "Connection Failed" : "Connecting"}
        </h2>

        <p id="connection-status-desc" className="mb-8 text-center text-[var(--chalk-app-text-muted)]">
          {message || defaultMessages[status]}
        </p>

        {supportCode && (
          <ChalkPanel className="mb-6 w-full p-3" tone="neutral">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--chalk-app-text-muted)]">Support Code</p>
            <p className="mt-1 break-all font-mono text-xs text-[var(--chalk-app-text)]">{supportCode}</p>
          </ChalkPanel>
        )}

        {status === "failed" && (
          <div className="flex w-full flex-col gap-3">
            {onRetry && (
              <ChalkButton type="button" onClick={onRetry} variant="solid" tone="accent" className="w-full font-medium text-[var(--chalk-app-control-active-text)]">
                Try Again
              </ChalkButton>
            )}
            {onLeft && (
              <ChalkButton type="button" onClick={onLeft} variant="outline" tone="neutral" className="w-full font-medium text-[var(--chalk-app-text)]">
                Leave Space
              </ChalkButton>
            )}
          </div>
        )}
      </ChalkDialogPanel>
    </div>
  );
});

ChalkReconnectingOverlay.displayName = "ChalkReconnectingOverlay";

export const ReconnectingOverlay = React.memo<ReconnectingOverlayProps>((props: ReconnectingOverlayProps) => {
  const skin = useSkin();
  return skin === "classic" ? <ClassicReconnectingOverlay {...props} /> : <ChalkReconnectingOverlay {...props} />;
});

ReconnectingOverlay.displayName = "ReconnectingOverlay";
