import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";
import type { NativeAppHealth } from "./run-marker";

const WINDOW_MS = 30_000;
const THERMAL_STATES = new Set(["nominal", "fair", "serious", "critical", "light", "moderate", "severe", "emergency", "shutdown"]);

type AppStateLike = {
  currentState: string;
  addEventListener(type: string, listener: (state: string) => void): { remove(): void };
};

/**
 * The native app's 30 s health window and its OS probes: JS-thread lag from a single 1 s interval, AppState, low memory
 * and the OS thermal state. Emits client.perf_heartbeat, client.memory_warning and client.thermal_changed.
 */
export function startNativeProbes(outbox: TelemetryOutbox, health: NativeAppHealth | null, appState: AppStateLike, appStateNow: () => "active" | "inactive" | "background"): () => void {
  let jsLagMax = 0;
  let lastTick = Date.now();
  let lastThermal: string | undefined;
  let lowMemorySeen = false;
  const lag = setInterval(() => {
    const now = Date.now();
    jsLagMax = Math.max(jsLagMax, now - lastTick - 1000);
    lastTick = now;
  }, 1000);

  const stateSub = appState.addEventListener("change", (state) => health?.setAppState(state));
  const memorySub = appState.addEventListener("memoryWarning", () => {
    outbox.obs.fact("client.memory_warning", { app_state: appStateNow() });
  });

  const heartbeat = setInterval(() => {
    const state = appStateNow();
    health?.setAppState(state);
    void Promise.all([health?.lowMemory().catch(() => null) ?? Promise.resolve(null), health?.thermalState().catch(() => "unsupported") ?? Promise.resolve("unsupported")]).then(([low, thermal]) => {
      const lowFlag = low === true;
      if (lowFlag && !lowMemorySeen) outbox.obs.fact("client.memory_warning", { app_state: state, low_memory: true });
      lowMemorySeen = lowMemorySeen || lowFlag;
      const measured = thermal !== "unsupported" && THERMAL_STATES.has(thermal);
      if (thermal !== lastThermal) {
        lastThermal = thermal;
        outbox.obs.fact("client.thermal_changed", { probe_state: measured ? "measured" : "unsupported", ...(measured ? { thermal_state: thermal as never } : { thermal_state: "unsupported" }), app_state: state });
      }
      outbox.obs.fact("client.perf_heartbeat", {
        window_ms: WINDOW_MS,
        app_state: state,
        js_lag_max_ms_30s: jsLagMax,
        memory_state: low === null ? "unsupported" : low ? "low" : "ok",
        ...(low === null ? {} : { low_memory: low }),
      });
      jsLagMax = 0;
    });
  }, WINDOW_MS);

  void (health?.thermalState().catch(() => "unsupported") ?? Promise.resolve("unsupported")).then((thermal) => {
    lastThermal = thermal;
    const measured = THERMAL_STATES.has(thermal);
    outbox.obs.fact("client.thermal_changed", { probe_state: measured ? "measured" : "unsupported", ...(measured ? { thermal_state: thermal as never } : { thermal_state: "unsupported" }), app_state: appStateNow() });
  });

  return () => {
    clearInterval(lag);
    clearInterval(heartbeat);
    stateSub.remove();
    memorySub.remove();
  };
}
