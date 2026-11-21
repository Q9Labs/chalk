import { startHeartbeat } from "./heartbeat";
import type { TelemetryOutbox } from "./outbox";
import { startCpuPressureProbe } from "./perf-probes";
import { answerMarkerPings, broadcastPing, scanPreviousRuns } from "./previous-run";
import { openRunMarker } from "./run-marker";

/**
 * The web run's health wiring: opens this run's marker, reports dead previous runs once, keeps the 30 s heartbeat and the
 * CPU-pressure probe, and marks the marker's clean exit when the page goes away. Web only — React Native's app-health
 * wiring lives in the react-native package. Returns the way to stop.
 */

/** A store that keeps nothing, used where localStorage is blocked: the next run then finds no marker, an honest gap. */
const inertStorage = { length: 0, key: () => null, getItem: () => null, setItem: () => undefined, removeItem: () => undefined };

const markerStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export function installWebRunHealth(outbox: TelemetryOutbox): () => void {
  const documentTarget = globalThis.document;
  const storage = markerStorage();
  const visibility = (): "visible" | "hidden" => (documentTarget?.visibilityState === "hidden" ? "hidden" : "visible");
  const marker = openRunMarker(storage ?? inertStorage, outbox.clientSessionId, Date.now, () => performance.now());
  const stopPing = answerMarkerPings(outbox.clientSessionId);
  void scanPreviousRuns(outbox, {
    storage: storage ?? inertStorage,
    ownCs: outbox.clientSessionId,
    ping: broadcastPing(),
    wasDiscarded: (documentTarget as { wasDiscarded?: boolean } | undefined)?.wasDiscarded,
  }).catch(() => undefined);
  const heap = () => {
    const memory = (globalThis.performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory;
    if (memory === undefined) return {};
    return { heap_used_mib: Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10, heap_limit_mib: Math.round((memory.jsHeapSizeLimit / 1048576) * 10) / 10 };
  };
  const heartbeat = startHeartbeat(outbox, {
    visibility,
    onTick: () => {
      if (documentTarget !== undefined) marker.update({ phase: "live", visibility: visibility(), ...heap() });
    },
  });
  const stopPressure = startCpuPressureProbe(outbox, { visibility });
  const bind = outbox.bind.bind(outbox);
  outbox.bind = (source) => {
    marker.update({ phase: "joining", visibility: visibility() });
    return bind(source);
  };
  const onPageHide = () => marker.close("pagehide");
  const onVisibility = () => marker.update({ visibility: visibility() });
  globalThis.window?.addEventListener("pagehide", onPageHide);
  documentTarget?.addEventListener("visibilitychange", onVisibility);
  return () => {
    globalThis.window?.removeEventListener("pagehide", onPageHide);
    documentTarget?.removeEventListener("visibilitychange", onVisibility);
    heartbeat.stop();
    stopPressure();
    stopPing();
    marker.remove();
  };
}
