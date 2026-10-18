import React, { useEffect, useState, useSyncExternalStore } from "react";
import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
import { CallLimbo } from "../call-limbo/CallLimbo";
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
  const connection = useConnection();
  const offline = useOffline();
  const online = useSyncExternalStore(subscribeToOnline, readOnline, () => true);
  const reconnecting = requestedReconnecting || connection.status === "reconnecting";
  const reconnectingNoticeDue = useTrueFor(reconnecting, RECONNECTING_GRACE_MS);

  useEffect(() => {
    void client.offline.setPolicy("send");
  }, [client]);

  // Keep the layer mounted so recovery lifts the blur rather than removing it abruptly.
  if (reconnecting || (!offline.decisionNeeded && !offline.notice)) return <CallLimbo overlay active={reconnectingNoticeDue} message={offlineNoticeText(offline.pending.length, online)} />;
  if (offline.notice)
    return (
      <p role="status" className="absolute inset-x-0 top-3 z-40 mx-auto w-fit rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-3.5 py-2 text-sm text-[var(--chalk-app-text)]">
        {offline.notice}
      </p>
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
