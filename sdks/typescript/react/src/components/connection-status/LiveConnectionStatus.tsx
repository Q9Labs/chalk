import { useEffect, useSyncExternalStore } from "react";
import { useConnection, useOffline, useSpaceClient } from "../../bindings/hooks";
import { ConnectionStatus } from "./ConnectionStatus";
import type { ConnectionPhase } from "./use-connection-phase";

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

  const count = offline.pending.length;
  const messagesOnly = offline.pending.every((action) => action.kind === "chat_message");
  const pending = count ? `${count} ${messagesOnly ? (count === 1 ? "message" : "messages") : count === 1 ? "action" : "actions"}` : null;
  if (phase.kind === "live") return null;
  if (phase.kind === "failed") return <ConnectionStatus phase="failed" since={null} onRejoin={onRejoin} onLeave={onLeave} onReportProblem={onReportProblem} />;
  if (phase.kind === "reconnected") return <ConnectionStatus phase="reconnected" since={null} awayMs={phase.awayMs} />;
  return <ConnectionStatus phase={online ? "reconnecting" : "offline"} since={phase.since} pending={pending} />;
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
