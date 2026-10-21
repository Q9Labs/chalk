import React, { useEffect, useState, useSyncExternalStore } from "react";
import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
import { ToastStack } from "../toast-stack/ToastStack";
/** Most drops recover within a second or two, so the notice waits this long before it appears. */
export const RECONNECTING_GRACE_MS = 2_000;

export function offlineNoticeText(pendingCount: number, online: boolean): string {
  const state = online ? "Reconnecting" : "You're offline";
  if (pendingCount === 0) return online ? "Reconnecting…" : "You're offline. Reconnecting…";
  return `${state}. ${pendingCount === 1 ? "1 action" : `${pendingCount} actions`} will send when you're back.`;
}

/** Keep queued actions automatic while preserving the reconnecting notice. */
export function OfflineActions({ reconnecting: requestedReconnecting = false }: { readonly reconnecting?: boolean } = {}): React.JSX.Element | null {
  const client = useSpaceClient();
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const connection = useConnection();
  const offline = useOffline();
  const online = useSyncExternalStore(subscribeToOnline, readOnline, () => true);
  const reconnecting = requestedReconnecting || connection.status === "reconnecting";
  const reconnectingNoticeDue = useTrueFor(reconnecting, RECONNECTING_GRACE_MS);

  useEffect(() => {
    void client.offline.setPolicy("send");
  }, [client]);

  const count = offline.pending.length;
  const messagesOnly = offline.pending.every((action) => action.kind === "chat_message");
  const pendingDetail = count ? `${count} ${messagesOnly ? (count === 1 ? "message" : "messages") : count === 1 ? "action" : "actions"} will send when you’re back` : undefined;
  const notice = reconnecting ? (reconnectingNoticeDue ? `${offlineNoticeText(0, online)}${pendingDetail ? ` ${pendingDetail}` : ""}` : null) : connection.syncHealth === "degraded" ? "Connection is slow" : null;
  if (notice)
    return (
      <div role="status" data-part="connection-notice" className="pointer-events-none absolute inset-x-4 top-16 z-50 mx-auto w-fit max-w-[calc(100%_-_2rem)] rounded-full bg-[var(--chalk-surface)] px-3 py-1 text-center text-sm text-[var(--chalk-text)]">
        {notice}
      </div>
    );
  if (offline.notice && offline.notice !== dismissedNotice) return <ToastStack toasts={[{ id: "offline-notice", message: offline.notice }]} onDismiss={() => setDismissedNotice(offline.notice ?? null)} />;
  return null;
}

function useTrueFor(value: boolean, milliseconds: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    setElapsed(false);
    if (!value) return;
    const timer = setTimeout(() => setElapsed(true), milliseconds);
    return () => clearTimeout(timer);
  }, [milliseconds, value]);
  return value && elapsed;
}

function subscribeToOnline(onChange: () => void): () => void {
  globalThis.addEventListener?.("online", onChange);
  globalThis.addEventListener?.("offline", onChange);
  return () => {
    globalThis.removeEventListener?.("online", onChange);
    globalThis.removeEventListener?.("offline", onChange);
  };
}

function readOnline(): boolean {
  return globalThis.navigator?.onLine ?? true;
}
