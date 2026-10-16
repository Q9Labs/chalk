import React from "react";
import { ClassicReconnectingOverlay } from "./ClassicReconnectingOverlay";
import { ReconnectingNotice } from "./ReconnectingNotice";

/** A reconnecting state shorter than this shows a non-blocking notice; longer shows the modal. */
export const RECONNECTING_NOTICE_MS = 10_000;

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

  if (isReconnecting && !escalated) return props.showNotice === false ? null : <ReconnectingNotice className={props.className} />;
  return <ClassicReconnectingOverlay {...props} />;
});

ReconnectingOverlay.displayName = "ReconnectingOverlay";
