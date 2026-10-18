import React from "react";
import { ClassicReconnectingOverlay } from "./ClassicReconnectingOverlay";
import { CallLimbo } from "../call-limbo/CallLimbo";

/** Brief interruptions do not obscure the call. */
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

export const ReconnectingOverlay = React.memo<ReconnectingOverlayProps>((props: ReconnectingOverlayProps) => {
  const isReconnecting = props.isVisible && props.status === "reconnecting";
  const [escalated, setEscalated] = React.useState(false);

  React.useEffect(() => {
    if (!isReconnecting) {
      setEscalated(false);
      return;
    }
    const timer = setTimeout(() => setEscalated(true), RECONNECTING_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [isReconnecting]);

  if (props.status === "reconnecting") return props.showNotice === false ? null : <CallLimbo overlay active={isReconnecting && escalated} message={props.message ?? "Reconnecting…"} />;
  return <ClassicReconnectingOverlay {...props} />;
});

ReconnectingOverlay.displayName = "ReconnectingOverlay";
