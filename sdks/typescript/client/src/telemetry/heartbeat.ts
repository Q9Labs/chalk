import { HEARTBEAT_WORKER_SOURCE, type HeartbeatWorkerMessage } from "./heartbeat-worker";
import type { TelemetryOutbox } from "./outbox";

const WINDOW_MS = 30_000;
const THROTTLE_MS = 45_000;

type HeapProbe = { readonly used_mib?: number; readonly limit_mib?: number; readonly state: "measured" | "unsupported" };

/** Reads performance.memory where the browser exposes it. Absent is unsupported, never 0. */
export function probeHeap(): HeapProbe {
  const memory = (globalThis.performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } } | undefined)?.memory;
  if (memory === undefined || typeof memory.usedJSHeapSize !== "number") return { state: "unsupported" };
  return { state: "measured", used_mib: Math.round((memory.usedJSHeapSize / 1048576) * 10) / 10, limit_mib: Math.round((memory.jsHeapSizeLimit / 1048576) * 10) / 10 };
}

export type HeartbeatHandle = { readonly stop: () => void };

/**
 * The 30 s health window of a web run: long tasks on the main thread, the worker's ping round trip, how late the worker's
 * own tick ran, the heap probe and the page's visibility. It emits client.perf_heartbeat each window and
 * client.timer_throttled when the worker froze over 45 s. One interval on the main thread drives the window; the worker
 * keeps the second-by-second timers, and nothing else is wrapped.
 */
export function startHeartbeat(outbox: TelemetryOutbox, options: { visibility: () => "visible" | "hidden"; onTick?: () => void; worker?: Worker; windowMs?: number }): HeartbeatHandle {
  const windowMs = options.windowMs ?? WINDOW_MS;
  let longTaskMax = 0;
  let longTaskTotal = 0;
  let pingMax = 0;
  let workerLateMax = 0;
  let lastWorkerTick = Date.now();
  let throttledSince = 0;

  const observer =
    typeof PerformanceObserver === "undefined"
      ? undefined
      : new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTaskMax = Math.max(longTaskMax, Math.round(entry.duration));
            longTaskTotal += entry.duration;
          }
        });
  try {
    observer?.observe({ type: "longtask", buffered: true });
  } catch {
    // A browser without longtask leaves the fields absent, which reads as a gap, not health.
  }

  let worker: Worker | undefined = options.worker;
  if (worker === undefined && typeof Worker !== "undefined" && typeof Blob !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([HEARTBEAT_WORKER_SOURCE], { type: "text/javascript" })));
    } catch {
      worker = undefined;
    }
  }
  if (worker !== undefined) {
    worker.onmessage = (event: MessageEvent<HeartbeatWorkerMessage>) => {
      const data = event.data;
      if (data.t === "ping") worker.postMessage({ t: "pong" });
      else if (data.t === "ping_ms") pingMax = Math.max(pingMax, data.ms);
      else if (data.t === "tick_late") {
        workerLateMax = Math.max(workerLateMax, data.ms);
        lastWorkerTick = data.last;
      }
    };
  }

  const interval = setInterval(() => {
    options.onTick?.();
    if (worker !== undefined) worker.postMessage({ t: "collect" });
    // A main thread blocked for the whole window never reaches this line, and a suspended worker answers collect late.
    // The gap the silence leaves is the evidence, and the next window reports how late the worker's tick was.
    const heap = probeHeap();
    outbox.obs.fact("client.perf_heartbeat", {
      window_ms: windowMs,
      visibility: options.visibility(),
      long_task_max_ms_30s: longTaskMax,
      long_task_total_ms_30s: Math.round(longTaskTotal),
      ...(worker === undefined ? {} : { main_ping_max_ms_30s: pingMax, worker_late_max_ms_30s: workerLateMax }),
      heap_probe: heap.state,
      memory_state: heap.state === "measured" ? "measured" : "unsupported",
      ...(heap.used_mib === undefined ? {} : { heap_used_mib: heap.used_mib }),
      ...(heap.limit_mib === undefined ? {} : { heap_limit_mib: heap.limit_mib }),
    });
    longTaskMax = 0;
    longTaskTotal = 0;
    pingMax = 0;
    workerLateMax = 0;
  }, windowMs);

  const throttleCheck = setInterval(() => {
    if (worker === undefined) return;
    const silent = Date.now() - lastWorkerTick;
    if (silent > THROTTLE_MS && throttledSince !== lastWorkerTick) {
      throttledSince = lastWorkerTick;
      outbox.obs.fact("client.timer_throttled", { expected_ms: 1000, actual_ms: silent, visibility: options.visibility() });
    }
  }, 1000);

  return {
    stop: () => {
      clearInterval(interval);
      clearInterval(throttleCheck);
      observer?.disconnect();
      if (worker !== undefined) {
        worker.postMessage({ t: "stop" });
        worker.terminate();
      }
    },
  };
}
