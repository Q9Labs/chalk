import { failure } from "../obs/kernel";
import type { TelemetryOutbox } from "./outbox";
import { listRunMarkers, markerIsYoung, type RunMarker } from "./run-marker";

export type DeadRunReport = {
  readonly marker: RunMarker;
  readonly key: string;
};

/** BroadcastChannel-based liveness: a marker whose cs still answers is a live sibling, not a dead run. */
export type MarkerPing = (cs: string) => Promise<boolean>;

/** A ping nobody answers: browsers without BroadcastChannel treat every marker as a candidate. */
export const noPing: MarkerPing = () => Promise.resolve(false);

/** Pings a cs over BroadcastChannel and resolves true when the owning tab answers within `withinMs`. */
export function broadcastPing(withinMs = 250): MarkerPing {
  const channel = typeof BroadcastChannel === "undefined" ? undefined : BroadcastChannel;
  if (channel === undefined) return noPing;
  return (cs) =>
    new Promise((resolve) => {
      const reply = new channel(`chalk.run_marker.reply.${cs}`);
      const timer = setTimeout(() => {
        reply.close();
        resolve(false);
      }, withinMs);
      reply.onmessage = () => {
        clearTimeout(timer);
        reply.close();
        resolve(true);
      };
      const call = new channel("chalk.run_marker.ping");
      call.postMessage(cs);
      call.close();
    });
}

/** Answers marker pings for this run's own cs, so a scanning sibling never reports a live tab dead. */
export function answerMarkerPings(cs: string): () => void {
  const channel = typeof BroadcastChannel === "undefined" ? undefined : BroadcastChannel;
  if (channel === undefined) return () => undefined;
  const listener = new channel("chalk.run_marker.ping");
  listener.onmessage = (event) => {
    if (event.data === cs) {
      const reply = new channel(`chalk.run_marker.reply.${cs}`);
      reply.postMessage(cs);
      reply.close();
    }
  };
  return () => listener.close();
}

/**
 * The once-per-boot scan for dead run markers: records previous_run.read, emits client.previous_run for each dead marker,
 * and forgets keys it reported so one dead run is reported once. Runs under this run's credential, never the dead one's.
 */
export async function scanPreviousRuns(outbox: TelemetryOutbox, options: { storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">; ownCs: string; ping: MarkerPing; wasDiscarded?: boolean }): Promise<readonly DeadRunReport[]> {
  return outbox.obs.op("previous_run.read", {}, async (scope) => {
    let markers;
    try {
      markers = listRunMarkers(options.storage);
    } catch (error) {
      throw failure("app.storage_unreadable", error);
    }
    const dead: DeadRunReport[] = [];
    const wallNow = Date.now();
    for (const { key, marker } of markers) {
      if (marker.cs === options.ownCs || markerIsYoung(marker, wallNow)) continue;
      if (await options.ping(marker.cs)) continue;
      dead.push({ key, marker });
    }
    scope.set({ dead_markers: dead.length });
    if (dead.length === 0) scope.expected("app.no_marker");
    for (const { key, marker } of dead) {
      outbox.obs.fact("client.previous_run", {
        previous_client_session_id: marker.cs,
        phase: marker.phase,
        ...(marker.visibility === undefined ? {} : { visibility: marker.visibility }),
        ...(marker.clean_exit === undefined ? {} : { clean_exit: marker.clean_exit }),
        last_elapsed_ms: marker.last_elapsed_ms,
        ...(marker.heap_used_mib === undefined ? {} : { heap_used_mib: marker.heap_used_mib }),
        ...(marker.heap_limit_mib === undefined ? {} : { heap_limit_mib: marker.heap_limit_mib }),
        js_ready: true,
        ...(options.wasDiscarded === undefined ? {} : { was_discarded: options.wasDiscarded }),
      });
      try {
        options.storage.removeItem(key);
      } catch {
        // A key that stays is re-reported next boot: a duplicate, never a loss.
      }
    }
    return dead;
  });
}
