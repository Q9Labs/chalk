import React, { useEffect, useState, useSyncExternalStore } from "react";
import { ReconnectingCard, offlineNotice } from "../reconnecting-overlay/ReconnectingCard";
import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
/** Most drops recover within a second or two, so the notice waits this long before it appears. */
export const RECONNECTING_GRACE_MS = 2_000;

/** Keep queued actions automatic while preserving the reconnecting notice. */
export function OfflineActions({ reconnecting: requestedReconnecting = false, hasNotice = false }: { readonly reconnecting?: boolean; readonly hasNotice?: boolean } = {}): React.JSX.Element | null {
  const client = useSpaceClient();
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
  const pending = count ? `${count} ${messagesOnly ? (count === 1 ? "message" : "messages") : count === 1 ? "action" : "actions"}` : null;
  const slow = !reconnecting && connection.syncHealth === "degraded";
  if (hasNotice) return null;
  if (reconnecting && reconnectingNoticeDue) return <ReconnectingCard {...offlineNotice(online, pending)} />;
  if (slow)
    return (
      <div role="status" data-part="connection-notice" style={{ pointerEvents: "none" }} className="absolute inset-x-4 top-16 z-50 mx-auto w-fit max-w-[calc(100%_-_2rem)] rounded-full bg-[var(--chalk-surface)] px-3 py-1 text-center text-sm text-[var(--chalk-text)]">
        Connection is slow
      </div>
    );
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
