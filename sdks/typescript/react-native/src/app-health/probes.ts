import { AppState, type AppStateStatus } from "react-native";
import type { TelemetryOutbox } from "@q9labsai/chalk-client/telemetry/outbox";
import { markAppState, readLowMemory, readThermalState } from "./run-marker";

const WINDOW_MS = 30_000;
const THERMAL_BAD = new Set(["serious", "critical", "severe", "emergency", "shutdown"]);

/**
 * The native app's 30 s health window and its OS probes: JS-thread lag from a single 1 s interval, AppState, low memory
 * and the OS thermal state. Emits client.perf_heartbeat, client.memory_warning and client.thermal_changed.
 */
export function startNativeProbes(outbox: TelemetryOutbox): () => void {
  let jsLagMax = 0;
  let lastTick = Date.now();
  let lastThermal: string | undefined;
  let lowMemorySeen = false;
  const lag = setInterval(() => {
    const now = Date.now();
    jsLagMax = Math.max(jsLagMax, now - lastTick - 1000);
    lastTick = now;
  }, 1000);

  const appStateNow = (): "active" | "inactive" | "background" => (AppState.currentState === "active" ? "active" : AppState.currentState === "inactive" ? "inactive" : "background");
  const stateSub = AppState.addEventListener("change", (state: AppStateStatus) => markAppState(state));
  const memorySub = AppState.addEventListener("memoryWarning", () => {
    outbox.obs.fact("client.memory_warning", { app_state: appStateNow() });
  });

  const heartbeat = setInterval(() => {
    const state = appStateNow();
    markAppState(state);
    void Promise.all([readLowMemory(), readThermalState()]).then(([low, thermal]) => {
      const lowFlag = low === true;
      if (lowFlag && !lowMemorySeen) outbox.obs.fact("client.memory_warning", { app_state: state, low_memory: true });
      lowMemorySeen = lowMemorySeen || lowFlag;
      if (thermal !== lastThermal) {
        lastThermal = thermal;
        const measured = thermal !== "unsupported";
        outbox.obs.fact("client.thermal_changed", { probe_state: measured ? "measured" : "unsupported", thermal_state: thermal as never, app_state: state });
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

  void readThermalState().then((thermal) => {
    lastThermal = thermal;
    outbox.obs.fact("client.thermal_changed", { probe_state: thermal === "unsupported" ? "unsupported" : "measured", thermal_state: thermal as never, app_state: appStateNow() });
  });

  return () => {
    clearInterval(lag);
    clearInterval(heartbeat);
    stateSub.remove();
    memorySub.remove();
  };
}
