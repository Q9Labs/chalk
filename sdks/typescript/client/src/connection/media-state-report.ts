import type { ConnectionMediaSnapshot } from "../media";
import type { TransportDiagnostic } from "../transport-diagnostics";
import { reportedNetworkType } from "./network-type";

export function mediaDiagnosticPhase(snapshot: ConnectionMediaSnapshot | null) {
  return snapshot?.connection.peerConnectionState ?? snapshot?.connection.phase;
}

/**
 * Reports each media phase and ICE state once, in the order the transport reached them. It sees a snapshot straight from the
 * transport's subscription, so a state reached while a join or recovery holds the lifecycle's queue is not lost. No snapshot
 * means no media: it forgets what it reported, so the next media reports from the start.
 */
export function createMediaStateReporter(report: (event: TransportDiagnostic) => void) {
  let last: { readonly phase: string; readonly ice: string | undefined } | null = null;
  return {
    observe(snapshot: ConnectionMediaSnapshot | null) {
      const phase = mediaDiagnosticPhase(snapshot);
      const ice = snapshot?.connection.iceConnectionState ?? undefined;
      if (phase === undefined) last = null;
      else if (last?.phase !== phase || last.ice !== ice) {
        last = { phase, ice };
        report({ event: "media_state", phase, ice_state: ice, network_type: reportedNetworkType() });
      }
      return snapshot;
    },
  };
}
