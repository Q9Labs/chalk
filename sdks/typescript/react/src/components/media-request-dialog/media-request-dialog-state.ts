import { useEffect, useMemo, useState } from "react";
import type { IncomingMediaRequest } from "@q9labsai/chalk-client";

export type MediaRequestAction = "allow" | "decline";

export type MediaRequestActionHandler = () => void | Promise<void>;

export type MediaRequestActionErrorHandler = (message: string | null, action: MediaRequestAction) => void;

interface MediaRequestDialogStateOptions {
  readonly request: IncomingMediaRequest;
  readonly onDecline: MediaRequestActionHandler;
  readonly onAllow: MediaRequestActionHandler;
  readonly onActionError?: MediaRequestActionErrorHandler;
}

export interface MediaRequestDialogState {
  readonly isExpired: boolean;
  readonly expiryLabel: string | null;
  readonly pendingAction: MediaRequestAction | null;
  readonly errorMessage: string | null;
  readonly runAction: (action: MediaRequestAction) => void;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "This media request could not be completed.";
}

function formatExpiryLabel(expiresAtMs: number, now: number): string | null {
  if (!Number.isFinite(expiresAtMs)) return null;
  const remainingSeconds = Math.max(0, Math.ceil((expiresAtMs - now) / 1000));
  if (remainingSeconds <= 0) return "This request has expired.";
  if (remainingSeconds < 60) return `Expires in ${remainingSeconds}s`;
  const minutes = Math.ceil(remainingSeconds / 60);
  return `Expires in ${minutes} min`;
}

export function useMediaRequestDialogState({ request, onDecline, onAllow, onActionError }: MediaRequestDialogStateOptions): MediaRequestDialogState {
  const expiresAtMs = useMemo(() => Date.parse(request.expiresAt), [request.expiresAt]);
  const [now, setNow] = useState(() => Date.now());
  const [pendingAction, setPendingAction] = useState<MediaRequestAction | null>(null);
  const [errorMessageState, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    setPendingAction(null);
    setErrorMessage(null);
  }, [request.requestId]);

  useEffect(() => {
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [expiresAtMs]);

  const isExpired = Number.isFinite(expiresAtMs) && now >= expiresAtMs;
  const expiryLabel = formatExpiryLabel(expiresAtMs, now);

  const runAction = (action: MediaRequestAction) => {
    if (isExpired || pendingAction) return;
    const handler = action === "allow" ? onAllow : onDecline;
    setPendingAction(action);
    setErrorMessage(null);

    Promise.resolve()
      .then(handler)
      .then(() => onActionError?.(null, action))
      .catch((cause: unknown) => {
        const message = errorMessage(cause);
        setErrorMessage(message);
        onActionError?.(message, action);
      })
      .finally(() => setPendingAction(null));
  };

  return { isExpired, expiryLabel, pendingAction, errorMessage: errorMessageState, runAction };
}
