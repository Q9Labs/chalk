import { lazy, Suspense, useEffect, useSyncExternalStore } from "react";
import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
import type { ConnectionPhase } from "./use-connection-phase";

const loadConnectionStatus = () => import("./ConnectionStatus");
// The card is rare, so it stays out of the first download. It is fetched once the call is live, because a dropped link cannot fetch it.
const ConnectionStatus = lazy(() => loadConnectionStatus().then((module) => ({ default: module.ConnectionStatus })));

export interface LiveConnectionStatusProps {
  readonly phase: ConnectionPhase;
  readonly onRejoin?: () => void;
  readonly onLeave?: () => void;
  readonly onReportProblem?: () => void;
}

/** Joins the call's connection to the card: queued chat, whether the device is online, and the code a failure carries. */
export function LiveConnectionStatus({ phase, onRejoin, onLeave, onReportProblem }: LiveConnectionStatusProps) {
  const client = useSpaceClient();
  const connection = useConnection();
  const offline = useOffline();
  const online = useSyncExternalStore(subscribeToOnline, readOnline, () => true);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Set the client offline policy to send after mounting; changing durable queue policy during render is unsafe.
  useEffect(() => {
    void client.offline.setPolicy("send");
  }, [client]);

  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [resource] Fetch the card chunk after mounting so it is cached before a link drops.
  useEffect(() => {
    // A failed fetch only means the card loads when it is first needed.
    void loadConnectionStatus().catch(() => undefined);
  }, []);

  const count = offline.pending.length;
  const messagesOnly = offline.pending.every((action) => action.kind === "chat_message");
  const pending = count ? `${count} ${messagesOnly ? (count === 1 ? "message" : "messages") : count === 1 ? "action" : "actions"}` : null;
  if (phase.kind === "live") return null;
  return (
    <Suspense fallback={null}>
      {phase.kind === "failed" ? (
        <ConnectionStatus phase="failed" since={null} errorCode={connection.lastError?.code} onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />
      ) : phase.kind === "reconnected" ? (
        <ConnectionStatus phase="reconnected" since={null} awayMs={phase.awayMs} />
      ) : (
        <ConnectionStatus phase={online ? "reconnecting" : "offline"} since={phase.since} pending={pending} />
      )}
    </Suspense>
  );
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
