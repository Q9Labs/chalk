import { memo, useEffect, useState } from "react";
import { CallLimbo } from "../call-limbo/CallLimbo";
import { StatusSurface } from "../chalk/StatusSurface";
export const RECONNECTING_NOTICE_MS = 2_000;
export interface ReconnectingOverlayProps {
  isVisible: boolean;
  status: "connecting" | "reconnecting" | "failed";
  onRetry?: () => void;
  onLeft?: () => void;
  message?: string;
  supportCode?: string;
  className?: string;
  showNotice?: boolean;
}
export const ReconnectingOverlay = memo(function ReconnectingOverlay({ isVisible, status, onRetry, onLeft, message, showNotice }: ReconnectingOverlayProps) {
  const reconnecting = isVisible && status === "reconnecting";
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!reconnecting) return;
    const timer = setTimeout(() => setElapsed(true), RECONNECTING_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [reconnecting]);
  if (status === "reconnecting") return showNotice === false ? null : <CallLimbo overlay blocking={false} active={reconnecting && elapsed} message={message ?? "Reconnecting…"} />;
  if (!isVisible) return null;
  if (status === "failed")
    return (
      <div className="absolute inset-0 z-50">
        <StatusSurface phase="failed" reason={message} onRetry={onRetry} onHome={onLeft} />
      </div>
    );
  return <CallLimbo overlay message={message ?? "Joining the call…"} />;
});
